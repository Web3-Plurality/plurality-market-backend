import express, { Request, Response } from 'express';
import axios from 'axios';
import { AppDataSource } from '../../../data-source';
import { ProfileAccess } from '../entity/profile-access';
import Logger from '../../../lib/logger';
import { isAuthenticatedMcp } from '../../user-service/middlewares/auth-middleware';
import { checkSubscriptionAndCreditLimit } from '../../subscription-service/middlewares/subscription-middleware';
import { chargeMcpCall } from '../../subscription-service/middlewares/charge-mcp-middleware';

export const mcpRouter = express.Router();

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

const profileAccessRepository = AppDataSource.getRepository(ProfileAccess);

// POST /mcp/semantic-search — proxy semantic similarity search to AI service
// Accepts Hydra JWT (via dual auth middleware) — used by MCP server
mcpRouter.post(
  '/semantic-search',
  isAuthenticatedMcp('mcp:tools'),
  checkSubscriptionAndCreditLimit,
  chargeMcpCall(10),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['MCP']
    /* #swagger.security = [{ "bearerAuth": [] }] */
    try {
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

      // Determine search strategy
      const searchPromises: Promise<any[]>[] = [];
      const aiHeaders = {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
      };

      if (profileIds && profileIds.length > 0) {
        // Specific profiles requested — resolve owner per profile and search each
        const sharedProfileOwners = new Map<string, string>();
        const sharedForOwnerLookup = await profileAccessRepository.find({
          where: { grantedToId: userId },
          select: ['profileId', 'ownerId'],
        });
        for (const sb of sharedForOwnerLookup) {
          sharedProfileOwners.set(sb.profileId, sb.ownerId);
        }

        for (const profileId of profileIds) {
          const effectiveUserId = sharedProfileOwners.get(profileId) || userId;
          searchPromises.push(
            axios
              .post(
                `${AI_SERVICE_URL}/rag/similarity-search`,
                { userId: effectiveUserId, profileId, query, k },
                { headers: aiHeaders },
              )
              .then((response) => response.data.results || [])
              .catch((err) => {
                Logger.error(`[MCP] Semantic search failed for profile ${profileId}: ${err.message}`);
                return [];
              }),
          );
        }
      } else {
        // No profiles specified — optimized: 1 call for all owned + N calls for shared
        // Step 1: Search ALL owned content in one call (no profileId filter)
        searchPromises.push(
          axios
            .post(`${AI_SERVICE_URL}/rag/similarity-search`, { userId, query, k }, { headers: aiHeaders })
            .then((response) => response.data.results || [])
            .catch((err) => {
              Logger.error(`[MCP] Semantic search failed for owned content: ${err.message}`);
              return [];
            }),
        );

        // Step 2: Search shared buckets (one call per shared profile with owner's userId)
        const sharedProfiles = await profileAccessRepository.find({
          where: { grantedToId: userId },
          select: ['profileId', 'ownerId'],
        });
        for (const sp of sharedProfiles) {
          searchPromises.push(
            axios
              .post(
                `${AI_SERVICE_URL}/rag/similarity-search`,
                { userId: sp.ownerId, profileId: sp.profileId, query, k },
                { headers: aiHeaders },
              )
              .then((response) => response.data.results || [])
              .catch((err) => {
                Logger.error(`[MCP] Semantic search failed for shared profile ${sp.profileId}: ${err.message}`);
                return [];
              }),
          );
        }
      }

      const resultsBySource = await Promise.all(searchPromises);

      // Flatten, sort by similarity score descending, take top-k
      const allResults = resultsBySource
        .flat()
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
    } catch (err: any) {
      Logger.error(`[MCP] POST /semantic-search error: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  },
);
