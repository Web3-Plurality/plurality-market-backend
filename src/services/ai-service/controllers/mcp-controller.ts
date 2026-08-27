import express, { Request, Response } from 'express';
import axios from 'axios';
import Logger from '../../../lib/logger';
import { isAuthenticatedMcp } from '../../user-service/middlewares/auth-middleware';
import { resolveProfileAccess } from '../utils/permission';

export const mcpRouter = express.Router();

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8001';

// POST /mcp/semantic-search — proxy semantic similarity search to AI service.
// Per-profile path resolves access first, then forwards the original creator's
// userId so NFT buyers (whose own userId doesn't match the S3 vectors) can
// search buckets they hold. Mirrors the /ai/context/:contextId/content pattern.
mcpRouter.post('/semantic-search', isAuthenticatedMcp('mcp:tools'), async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authAddress = (req as any).user?.authAddress;
    if (!userId || !authAddress) {
      return res.status(401).json({ error: 'User identity not found in token' });
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
      // Resolve access per profileId. If granted, use access.ownerId — the
      // original creator's userId — as the S3 filter, since vectors were
      // written under that id. Unauthorized profiles are silently dropped.
      for (const profileId of profileIds) {
        searchPromises.push(
          (async () => {
            const access = await resolveProfileAccess(authAddress, userId, profileId);
            if (!access.hasAccess) {
              return [];
            }
            const effectiveUserId = access.ownerId || userId;
            try {
              const response = await axios.post(
                `${AI_SERVICE_URL}/rag/similarity-search`,
                { userId: effectiveUserId, profileId, query, k },
                { headers: aiHeaders },
              );
              return response.data.results || [];
            } catch (err) {
              Logger.error(`[MCP] Semantic search failed for profile ${profileId}: ${(err as Error).message}`);
              return [];
            }
          })(),
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
