import express, { Request, Response } from 'express';
import { IsNull, MoreThan } from 'typeorm';
import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import { PersonalAccessToken } from '../entity/personal-access-token';
import { generateToken, hashToken, verifyTokenHash, isPatToken } from '../utils/token-utils';
import {
  PAT_LIMIT,
  ALLOWED_PAT_SCOPES,
  AllowedPatScope,
  AUTO_PAT_TTL_MS,
  AUTO_PAT_NAME,
  AUTO_PAT_MINTS_PER_MINUTE,
} from '../utils/limits';
import { revokeAutoTokensForUser, cleanupRevokedAutoTokens } from '../utils/auto-pat';

export const tokenRouter = express.Router();
const tokenRepository = AppDataSource.getRepository(PersonalAccessToken);

// Per-user sliding-window counter for auto-token mints. In-memory is fine:
// the backend is a single instance, and the worst case on restart is a
// briefly reset window.
const autoMintLog = new Map<string, number[]>();
function autoMintAllowed(userId: string): boolean {
  const now = Date.now();
  const recent = (autoMintLog.get(userId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= AUTO_PAT_MINTS_PER_MINUTE) {
    autoMintLog.set(userId, recent);
    return false;
  }
  recent.push(now);
  autoMintLog.set(userId, recent);
  return true;
}

function resolveExpiresAt(expiresIn: string | undefined): Date | null {
  if (!expiresIn || expiresIn === 'never') return null;
  const days = parseInt(expiresIn.replace(/[^0-9]/g, ''), 10);
  if (isNaN(days) || days <= 0) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function getClientIp(req: Request): string | null {
  const ip = (req.ip || req.socket?.remoteAddress || '').toString();
  return ip.length > 0 ? ip.slice(0, 45) : null;
}

// Only manual tokens count toward PAT_LIMIT — auto tokens are bounded by
// construction (one active per user).
function activeFilter(userId: string) {
  return {
    userId,
    kind: 'manual' as const,
    revokedAt: IsNull(),
  };
}

// Validate + normalize scopes from request body. Returns null if any scope is
// not in the allowed set; otherwise returns the deduped list (defaulted to
// ['mcp:tools'] when caller omits the field or sends an empty array).
function validateScopes(raw: unknown): AllowedPatScope[] | null {
  if (raw === undefined || raw === null) return ['mcp:tools'];
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return ['mcp:tools'];
  const allowed = new Set<string>(ALLOWED_PAT_SCOPES);
  const seen = new Set<AllowedPatScope>();
  for (const s of raw) {
    if (typeof s !== 'string' || !allowed.has(s)) return null;
    seen.add(s as AllowedPatScope);
  }
  return Array.from(seen);
}

// ── POST /pat/tokens ── create a new PAT
tokenRouter.post('/', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const authAddress = req.user?.authAddress;
    if (!userId || !authAddress) return res.status(401).json({ error: 'unauthenticated' });

    // ── Auto token for the in-app chat ──
    // `{ auto: true }` bypasses name/scope/expiry inputs: fixed name, mcp:tools,
    // 1h TTL. Exactly one active auto token per user — minting revokes the
    // previous one, so a token exfiltrated from an old tab dies on reload.
    if (req.body?.auto === true) {
      if (!autoMintAllowed(userId)) {
        return res.status(429).json({
          error: 'auto_pat_rate_limited',
          message: 'Too many chat sessions started in a short time. Try again in a minute.',
        });
      }
      await revokeAutoTokensForUser(userId);
      void cleanupRevokedAutoTokens();

      const { plaintext, prefix, hash } = generateToken();
      const expiresAt = new Date(Date.now() + AUTO_PAT_TTL_MS);
      const saved = await tokenRepository.save(
        tokenRepository.create({
          userId,
          authAddress,
          tokenHash: hash,
          tokenPrefix: prefix,
          name: AUTO_PAT_NAME,
          kind: 'auto',
          scopes: ['mcp:tools'],
          expiresAt,
          createdIp: getClientIp(req),
        }),
      );
      Logger.info(`[PAT] Minted auto token ${saved.id} for wallet ${authAddress} (expires ${expiresAt.toISOString()})`);
      return res.status(201).json({
        id: saved.id,
        token: plaintext,
        name: saved.name,
        tokenPrefix: saved.tokenPrefix,
        scopes: saved.scopes,
        expiresAt: saved.expiresAt,
        createdAt: saved.createdAt,
        kind: 'auto',
      });
    }

    const { name, expiresIn, scopes: rawScopes } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'name is too long (max 100 chars)' });
    }

    const scopes = validateScopes(rawScopes);
    if (!scopes) {
      return res.status(400).json({
        error: 'invalid_scopes',
        message: `scopes must be a subset of ${ALLOWED_PAT_SCOPES.join(', ')}`,
      });
    }

    const activeCount = await tokenRepository.count({
      where: [
        { ...activeFilter(userId), expiresAt: IsNull() },
        { ...activeFilter(userId), expiresAt: MoreThan(new Date()) },
      ],
    });
    if (activeCount >= PAT_LIMIT) {
      return res.status(429).json({
        error: 'pat_limit_reached',
        limit: PAT_LIMIT,
        active: activeCount,
        message: 'Token limit reached. Revoke an existing token to create a new one.',
      });
    }

    const { plaintext, prefix, hash } = generateToken();
    const expiresAt = resolveExpiresAt(expiresIn);

    const entity = tokenRepository.create({
      userId,
      authAddress,
      tokenHash: hash,
      tokenPrefix: prefix,
      name: name.trim(),
      scopes,
      expiresAt,
      createdIp: getClientIp(req),
    });
    const saved = await tokenRepository.save(entity);

    Logger.info(
      `[PAT] Created token ${saved.id} for wallet ${authAddress} (user ${userId}) scopes=${scopes.join(',')}`,
    );
    return res.status(201).json({
      id: saved.id,
      token: plaintext,
      name: saved.name,
      tokenPrefix: saved.tokenPrefix,
      scopes: saved.scopes,
      expiresAt: saved.expiresAt,
      createdAt: saved.createdAt,
    });
  } catch (err) {
    Logger.error('[PAT] Failed to create token', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /pat/tokens ── list active + recently-revoked tokens
tokenRouter.get('/', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Auto tokens are an implementation detail of the in-app chat — never listed.
    const tokens = await tokenRepository.find({
      where: { userId, kind: 'manual' },
      order: { createdAt: 'DESC' },
    });

    const now = new Date();
    const visible = tokens.filter((t) => {
      if (t.revokedAt) return t.revokedAt > thirtyDaysAgo;
      if (t.expiresAt && t.expiresAt < now) return t.expiresAt > thirtyDaysAgo;
      return true;
    });

    return res.json(
      visible.map((t) => ({
        id: t.id,
        name: t.name,
        tokenPrefix: t.tokenPrefix,
        scopes: t.scopes,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
        status: deriveStatus(t, now),
      })),
    );
  } catch (err) {
    Logger.error('[PAT] Failed to list tokens', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

function deriveStatus(t: PersonalAccessToken, now: Date): 'active' | 'expired' | 'revoked' {
  if (t.revokedAt) return 'revoked';
  if (t.expiresAt && t.expiresAt < now) return 'expired';
  return 'active';
}

// ── DELETE /pat/tokens/:id ── revoke
tokenRouter.delete('/:id', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const { id } = req.params;
    const token = await tokenRepository.findOne({ where: { id, userId } });
    if (!token) {
      return res.status(404).json({ error: 'token_not_found' });
    }
    if (token.revokedAt) {
      return res.status(204).send();
    }

    token.revokedAt = new Date();
    await tokenRepository.save(token);

    Logger.info(`[PAT] Revoked token ${id} for user ${userId}`);
    return res.status(204).send();
  } catch (err) {
    Logger.error('[PAT] Failed to revoke token', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /pat/tokens/verify ── internal endpoint used by MCP server
tokenRouter.get('/verify', async (req: Request, res: Response) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing_or_malformed_authorization' });
    }
    const plaintext = auth.slice(7).trim();
    if (!isPatToken(plaintext)) {
      return res.status(401).json({ error: 'not_a_pat' });
    }

    const hash = hashToken(plaintext);
    const token = await tokenRepository.findOne({ where: { tokenHash: hash } });
    if (!token) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    const now = new Date();
    if (token.revokedAt && token.revokedAt <= now) {
      return res.status(401).json({ error: 'revoked' });
    }
    if (token.expiresAt && token.expiresAt < now) {
      return res.status(401).json({ error: 'expired' });
    }

    if (!verifyTokenHash(plaintext, token.tokenHash)) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    tokenRepository
      .update(token.id, { lastUsedAt: now, lastUsedIp: getClientIp(req) })
      .catch((err) => Logger.warn(`[PAT] Failed to update last_used for ${token.id}: ${err.message}`));

    return res.json({
      // Wallet address is the canonical identifier downstream (MCP server
      // stamps it into a ContextVar, backend uses it for NFT-derived
      // permission checks). user_id is kept for callers still keyed by UUID.
      auth_address: token.authAddress,
      user_id: token.userId,
      scopes: token.scopes,
      expires_at: token.expiresAt,
    });
  } catch (err) {
    Logger.error('[PAT] Failed to verify token', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
