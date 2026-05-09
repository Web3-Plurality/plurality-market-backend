import express, { Request, Response } from 'express';
import { IsNull, MoreThan } from 'typeorm';
import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';
import { authAttempts } from '../../../lib/metrics';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import { getOrCreateUserSubscription, isPaidPlan } from '../../subscription-service/utils';
import { PersonalAccessToken } from '../entity/personal-access-token';
import { generateToken, hashToken, verifyTokenHash, isPatToken } from '../utils/token-utils';
import { PAT_LIMIT_PAID } from '../utils/limits';

export const tokenRouter = express.Router();
const tokenRepository = AppDataSource.getRepository(PersonalAccessToken);

// Resolve the optional `expiresIn` field from the create request to an absolute timestamp.
function resolveExpiresAt(expiresIn: string | undefined): Date | null {
  if (!expiresIn || expiresIn === 'never') return null;
  const days = parseInt(expiresIn.replace(/[^0-9]/g, ''), 10);
  if (isNaN(days) || days <= 0) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// Extract client IP — respects trust proxy setting set in index.ts.
function getClientIp(req: Request): string | null {
  const ip = (req.ip || req.socket?.remoteAddress || '').toString();
  return ip.length > 0 ? ip.slice(0, 45) : null;
}

// Active = not revoked, not expired, not the old half of a rotation.
function activeFilter(userId: string) {
  return {
    userId,
    revokedAt: IsNull(),
    rotatedToId: IsNull(),
  };
}

// ── POST /api/tokens — create a new PAT ───────────────────────────────
tokenRouter.post('/', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Tokens']
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const { name, expiresIn } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'name is too long (max 100 chars)' });
    }

    // Plan gate: free users cannot create PATs
    const subscription = await getOrCreateUserSubscription(userId);
    if (!isPaidPlan(subscription)) {
      return res.status(402).json({
        error: 'pat_requires_paid_plan',
        message: 'API tokens are available on paid plans. Upgrade to create a token.',
      });
    }

    // Active-token cap
    const activeCount = await tokenRepository.count({
      where: [
        { ...activeFilter(userId), expiresAt: IsNull() },
        { ...activeFilter(userId), expiresAt: MoreThan(new Date()) },
      ],
    });
    if (activeCount >= PAT_LIMIT_PAID) {
      return res.status(429).json({
        error: 'pat_limit_reached',
        limit: PAT_LIMIT_PAID,
        active: activeCount,
        message: 'Token limit reached. Revoke an existing token to create a new one.',
      });
    }

    const { plaintext, prefix, hash } = generateToken();
    const expiresAt = resolveExpiresAt(expiresIn);

    const entity = tokenRepository.create({
      userId,
      tokenHash: hash,
      tokenPrefix: prefix,
      name: name.trim(),
      scopes: ['mcp:tools'],
      expiresAt,
      createdIp: getClientIp(req),
    });
    const saved = await tokenRepository.save(entity);

    Logger.info(`[PAT] Created token ${saved.id} for user ${userId}`);
    return res.status(201).json({
      id: saved.id,
      token: plaintext, // plaintext returned exactly once
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

// ── GET /api/tokens — list active + recently-revoked tokens ────────────
tokenRouter.get('/', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Tokens']
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const tokens = await tokenRepository.find({
      where: { userId },
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
        rotatedToId: t.rotatedToId,
        status: deriveStatus(t, now),
      })),
    );
  } catch (err) {
    Logger.error('[PAT] Failed to list tokens', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

function deriveStatus(t: PersonalAccessToken, now: Date): 'active' | 'expired' | 'revoked' | 'rotated' {
  if (t.rotatedToId) return 'rotated';
  if (t.revokedAt) return 'revoked';
  if (t.expiresAt && t.expiresAt < now) return 'expired';
  return 'active';
}

// ── DELETE /api/tokens/:id — revoke ─────────────────────────────────────
tokenRouter.delete('/:id', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Tokens']
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const { id } = req.params;
    const token = await tokenRepository.findOne({ where: { id, userId } });
    if (!token) {
      return res.status(404).json({ error: 'token_not_found' });
    }
    if (token.revokedAt) {
      return res.status(204).send(); // already revoked, idempotent
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

// ── POST /api/tokens/:id/rotate — issue replacement, schedule old to revoke ──
tokenRouter.post('/:id/rotate', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Tokens']
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'unauthenticated' });

    const { id } = req.params;
    const gracePeriodDaysRaw = req.body?.gracePeriodDays;
    const gracePeriodDays =
      typeof gracePeriodDaysRaw === 'number' && gracePeriodDaysRaw >= 0 && gracePeriodDaysRaw <= 30
        ? gracePeriodDaysRaw
        : 7;

    const result = await AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PersonalAccessToken);
      const oldToken = await repo.findOne({ where: { id, userId } });
      if (!oldToken) return { status: 404 as const };
      if (oldToken.revokedAt) return { status: 409 as const, error: 'already_revoked' };
      if (oldToken.rotatedToId) return { status: 409 as const, error: 'already_rotated' };

      const { plaintext, prefix, hash } = generateToken();
      const newToken = repo.create({
        userId,
        tokenHash: hash,
        tokenPrefix: prefix,
        name: oldToken.name,
        scopes: oldToken.scopes,
        expiresAt: oldToken.expiresAt,
        createdIp: getClientIp(req),
      });
      const savedNew = await repo.save(newToken);

      const graceEnd = new Date();
      graceEnd.setDate(graceEnd.getDate() + gracePeriodDays);
      oldToken.rotatedToId = savedNew.id;
      oldToken.revokedAt = graceEnd; // future date — old still works until then
      await repo.save(oldToken);

      return { status: 201 as const, plaintext, saved: savedNew };
    });

    if (result.status === 404) {
      return res.status(404).json({ error: 'token_not_found' });
    }
    if (result.status === 409) {
      return res.status(409).json({ error: result.error });
    }

    Logger.info(`[PAT] Rotated token ${id} → ${result.saved.id} (grace ${gracePeriodDays}d) for user ${userId}`);
    return res.status(201).json({
      id: result.saved.id,
      token: result.plaintext,
      name: result.saved.name,
      tokenPrefix: result.saved.tokenPrefix,
      scopes: result.saved.scopes,
      expiresAt: result.saved.expiresAt,
      createdAt: result.saved.createdAt,
      gracePeriodDays,
    });
  } catch (err) {
    Logger.error('[PAT] Failed to rotate token', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /api/tokens/verify — internal endpoint used by MCP server ───────
// Authenticates via the PAT in the Authorization header itself.
tokenRouter.get('/verify', async (req: Request, res: Response) => {
  // #swagger.tags = ['Tokens']
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      authAttempts.inc({ method: 'pat', status: 'failure' });
      return res.status(401).json({ error: 'missing_or_malformed_authorization' });
    }
    const plaintext = auth.slice(7).trim();
    if (!isPatToken(plaintext)) {
      authAttempts.inc({ method: 'pat', status: 'failure' });
      return res.status(401).json({ error: 'not_a_pat' });
    }

    const hash = hashToken(plaintext);
    const token = await tokenRepository.findOne({ where: { tokenHash: hash } });
    if (!token) {
      authAttempts.inc({ method: 'pat', status: 'failure' });
      return res.status(401).json({ error: 'invalid_token' });
    }

    const now = new Date();
    if (token.revokedAt && token.revokedAt <= now) {
      authAttempts.inc({ method: 'pat', status: 'failure' });
      return res.status(401).json({ error: 'revoked' });
    }
    if (token.expiresAt && token.expiresAt < now) {
      authAttempts.inc({ method: 'pat', status: 'failure' });
      return res.status(401).json({ error: 'expired' });
    }

    // Constant-time double-check (defense in depth — DB lookup matched on hash already)
    if (!verifyTokenHash(plaintext, token.tokenHash)) {
      authAttempts.inc({ method: 'pat', status: 'failure' });
      return res.status(401).json({ error: 'invalid_token' });
    }

    // Fire-and-forget update of last_used (doesn't block response)
    tokenRepository
      .update(token.id, { lastUsedAt: now, lastUsedIp: getClientIp(req) })
      .catch((err) => Logger.warn(`[PAT] Failed to update last_used for ${token.id}: ${err.message}`));

    authAttempts.inc({ method: 'pat', status: 'success' });
    return res.json({
      user_id: token.userId,
      scopes: token.scopes,
      expires_at: token.expiresAt,
    });
  } catch (err) {
    Logger.error('[PAT] Failed to verify token', err);
    authAttempts.inc({ method: 'pat', status: 'failure' });
    return res.status(500).json({ error: 'internal_error' });
  }
});
