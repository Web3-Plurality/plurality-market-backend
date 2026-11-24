import { Request } from 'express';
import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';

/**
 * Per-wallet + per-IP daily quota for /mcp semantic-search (see
 * DailyLlmUsage). The stack runs no chat LLM anywhere — titles come from the
 * caller or cheap heuristics — so this is NOT about API-key burn: searches
 * run a local embedding pass and fan out one vector query per owned/held
 * bucket, which is real compute worth capping. Guarding the backend route
 * covers BOTH access paths uniformly: the AICF extension calls it directly
 * and the market MCP server proxies to it.
 *
 * Limits come from env so ops can tune/disable without a release; 0 disables
 * that dimension:
 *   LLM_DAILY_SEARCH_LIMIT_PER_WALLET (default 2000) — one account's volume.
 *   LLM_DAILY_SEARCH_LIMIT_PER_IP     (default 8000) — one machine scripting
 *                                                      many wallets.
 */
const SEARCH_WALLET_LIMIT = parseInt(process.env.LLM_DAILY_SEARCH_LIMIT_PER_WALLET || '2000', 10);
const SEARCH_IP_LIMIT = parseInt(process.env.LLM_DAILY_SEARCH_LIMIT_PER_IP || '8000', 10);

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function clientIpOf(req: Request): string {
  // `trust proxy` is set in index.ts, so req.ip is the client as seen by the
  // nearest proxy (Traefik on the stable domain). The ROFL-published port is
  // also directly reachable, where forwarded headers are attacker-controlled
  // — there the wallet cap still holds; the IP cap is best-effort by design.
  return (req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

// Increment-if-under-limit in ONE statement so concurrent requests cannot
// both pass a read-then-write check. The WHERE guards only the UPDATE branch;
// a brand-new (subject, day) row always inserts, which is correct — first
// use of the day can't already be over a sane limit.
async function consumeOne(
  subjectType: 'wallet_search' | 'ip_search',
  subject: string,
  cost: number,
  limit: number,
): Promise<boolean> {
  if (!limit || limit <= 0) return true;
  const rows: unknown[] = await AppDataSource.query(
    `INSERT INTO daily_llm_usage ("subjectType", subject, day, count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("subjectType", subject, day) DO UPDATE
       SET count = daily_llm_usage.count + $4
     WHERE daily_llm_usage.count + $4 <= $5
     RETURNING count`,
    [subjectType, subject, todayUtc(), cost, limit],
  );
  return rows.length > 0;
}

async function refundOne(
  subjectType: 'wallet_search' | 'ip_search',
  subject: string,
  cost: number,
): Promise<void> {
  await AppDataSource.query(
    `UPDATE daily_llm_usage
        SET count = GREATEST(count - $4, 0)
      WHERE "subjectType" = $1 AND subject = $2 AND day = $3`,
    [subjectType, subject, todayUtc(), cost],
  );
}

export async function consumeSearchQuota(req: Request, cost = 1): Promise<{ ok: boolean; message?: string }> {
  const wallet = (req.user?.authAddress || '').toLowerCase();
  const ip = clientIpOf(req);
  try {
    if (wallet && !(await consumeOne('wallet_search', wallet, cost, SEARCH_WALLET_LIMIT))) {
      return { ok: false, message: 'Daily search quota for this wallet is used up. Try again tomorrow.' };
    }
    if (!(await consumeOne('ip_search', ip, cost, SEARCH_IP_LIMIT))) {
      // Refund the wallet count consumed above — without this, retries from
      // behind an exhausted shared IP (office NAT) silently drain the
      // wallet's own daily quota although no search ever ran.
      if (wallet) await refundOne('wallet_search', wallet, cost);
      return { ok: false, message: 'Daily search quota for this network is used up. Try again tomorrow.' };
    }
    return { ok: true };
  } catch (err) {
    // Quota accounting must never take search down with it.
    Logger.warn(`[llm-quota] search accounting failed, allowing request: ${(err as Error).message}`);
    return { ok: true };
  }
}
