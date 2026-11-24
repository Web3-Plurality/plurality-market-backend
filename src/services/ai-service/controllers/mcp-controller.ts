import express, { Request, Response } from 'express';
import axios from 'axios';
import Logger from '../../../lib/logger';
import { isAuthenticatedMcp } from '../../user-service/middlewares/auth-middleware';
import { consumeSearchQuota } from '../utils/llm-quota';
import { resolveProfileAccess } from '../utils/permission';
import { AppDataSource } from '../../../data-source';
import { UserAiProfile } from '../entity/user-ai-profile';
import { walletToBucketHashes } from '../../blockchain-service/utils/wallet-nfts';

export const mcpRouter = express.Router();

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8001';
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);

// Upper bound on the per-request fan-out to the AI service when searching
// "all buckets" — keeps one MCP call from turning into hundreds of vector
// queries for pathological accounts.
const MAX_SEARCH_BUCKETS = 50;

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

    // Search quota: embeddings aren't free and the no-profileIds branch fans
    // out one vector query per bucket. One guard here covers every access
    // path (extension direct + MCP server proxy).
    const quota = await consumeSearchQuota(req);
    if (!quota.ok) {
      return res.status(429).json({ error: 'search_quota_exceeded', message: quota.message });
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
      // No profileIds → search EVERY bucket the caller can access: buckets
      // they created plus buckets whose NFT their wallet currently holds.
      // Vectors are written under (creator userId, profileId), so a single
      // userId-filtered query — what this branch used to send — matched
      // nothing: not the caller's own buckets (wrong namespace shape) and
      // certainly not purchased ones (creator's userId, not the caller's).
      const own = await userAiProfileRepository.find({ select: ['id', 'userId'], where: { userId } });
      let held: UserAiProfile[] = [];
      try {
        const heldHashes = await walletToBucketHashes(authAddress);
        if (heldHashes.size > 0) {
          held = await userAiProfileRepository
            .createQueryBuilder('p')
            .select(['p.id', 'p.userId'])
            .where('LOWER(p."bucketHash") IN (:...hashes)', { hashes: [...heldHashes] })
            .getMany();
        }
      } catch (err) {
        Logger.warn(`[MCP] held-NFT lookup failed; searching owned buckets only: ${(err as Error).message}`);
      }

      const seen = new Set<string>();
      const targets: UserAiProfile[] = [];
      for (const p of [...own, ...held]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        targets.push(p);
      }

      for (const p of targets.slice(0, MAX_SEARCH_BUCKETS)) {
        searchPromises.push(
          axios
            .post(
              `${AI_SERVICE_URL}/rag/similarity-search`,
              { userId: p.userId, profileId: p.id, query, k },
              { headers: aiHeaders },
            )
            .then((response) => response.data.results || [])
            .catch((err) => {
              Logger.error(`[MCP] Semantic search failed for profile ${p.id}: ${err.message}`);
              return [];
            }),
        );
      }
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
