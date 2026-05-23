import express, { Request, Response } from 'express';
import axios from 'axios';
import Logger from '../../../lib/logger';
import { isAuthenticatedMcp } from '../../user-service/middlewares/auth-middleware';

export const mcpRouter = express.Router();

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8001';

// POST /mcp/semantic-search — proxy semantic similarity search to AI service.
// Single-owner: caller's userId is the only one searched. (Sharing was
// removed in Phase 6 — no more cross-user fanout via profile_access.)
mcpRouter.post('/semantic-search', isAuthenticatedMcp('mcp:tools'), async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    const { query, profileIds, k = 5 } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query is required and must be a string' });
    }
    if (profileIds !== undefined && !Array.isArray(profileIds)) {
      return res.status(400).json({ error: 'profileIds must be an array of strings' });
    }

    const aiHeaders = {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchPromises: Promise<any[]>[] = [];

    if (profileIds && profileIds.length > 0) {
      // Specific profiles requested — search each under the caller's userId.
      for (const profileId of profileIds) {
        searchPromises.push(
          axios
            .post(`${AI_SERVICE_URL}/rag/similarity-search`, { userId, profileId, query, k }, { headers: aiHeaders })
            .then((response) => response.data.results || [])
            .catch((err) => {
              Logger.error(`[MCP] Semantic search failed for profile ${profileId}: ${err.message}`);
              return [];
            }),
        );
      }
    } else {
      // No profileIds → search all the caller's owned content in one call.
      searchPromises.push(
        axios
          .post(`${AI_SERVICE_URL}/rag/similarity-search`, { userId, query, k }, { headers: aiHeaders })
          .then((response) => response.data.results || [])
          .catch((err) => {
            Logger.error(`[MCP] Semantic search failed for owned content: ${err.message}`);
            return [];
          }),
      );
    }

    const resultsBySource = await Promise.all(searchPromises);

    const allResults = resultsBySource
      .flat()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sort((a: any, b: any) => (b.similarity_score || 0) - (a.similarity_score || 0))
      .slice(0, k);

    if (allResults.length === 0) {
      return res.json({ query, total_results: 0, results: [] });
    }

    return res.json({
      query,
      total_results: allResults.length,
      results: allResults,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    Logger.error(`[MCP] POST /semantic-search error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});
