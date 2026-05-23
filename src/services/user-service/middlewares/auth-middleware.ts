import jwt, { VerifyErrors } from 'jsonwebtoken';
import * as dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
import { COOKIE_NAME } from '../../auth-service/utils/cookie';
import { AppDataSource } from '../../../data-source';
import { PersonalAccessToken } from '../../token-service/entity/personal-access-token';
import { hashToken, isPatToken } from '../../token-service/utils/token-utils';

dotenv.config();

// req.user shape stamped by every middleware here. authAddress is the canonical
// identity; id is the User UUID carried alongside as a perf shortcut so
// controllers that still query by userId don't need an extra lookup per request.
//
// Both fields are derived from a verified credential — never from a header
// the client controls.
export interface AuthUser {
  id: string;
  authAddress: string;
  authMethod: 'native' | 'pat';
}

// ── Token extraction helper ────────────────────────────────────────────
function extractToken(req: Request): string | undefined {
  // Try HttpOnly cookie first (web app)
  let token = req.cookies?.[COOKIE_NAME];
  // Fall back to Authorization header (MCP clients sending PATs)
  if (!token) {
    token = req?.headers?.authorization && req?.headers?.authorization.split(' ')[1];
  }
  return token;
}

// ── Verify a Personal Access Token (PAT) against the DB ────────────────
// Returns userId, authAddress, scopes. authAddress comes denormalized from
// the PAT row so we don't have to join the users table on the hot path.
async function verifyPat(plaintext: string): Promise<{ userId: string; authAddress: string; scopes: string[] } | null> {
  const repo = AppDataSource.getRepository(PersonalAccessToken);
  const hash = hashToken(plaintext);
  const token = await repo.findOne({ where: { tokenHash: hash } });
  if (!token) return null;
  const now = new Date();
  if (token.revokedAt && token.revokedAt <= now) return null;
  if (token.expiresAt && token.expiresAt < now) return null;
  if (!token.authAddress) {
    // Pre-rewrite PAT without a denormalized wallet — should not exist after
    // Phase 12 wipe, but rejecting cleanly here is safer than synthesizing one.
    return null;
  }
  // Fire-and-forget last_used update — never block the hot path
  repo.update(token.id, { lastUsedAt: now }).catch(() => undefined);
  return { userId: token.userId, authAddress: token.authAddress, scopes: token.scopes };
}

// ── isAuthenticated: native JWTs only (secure default) ─────────────
// Rejects PATs — endpoints that need PATs (MCP-facing) use the variants below.
export const isAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).send('Token is missing');
  }

  if (isPatToken(token)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint does not accept Personal Access Tokens',
    });
  }

  // Internal JWT — verify against JWT_SECRET. New tokens carry
  // { authAddress, id }; reject anything that lacks authAddress so legacy
  // userId-only JWTs from before the rewrite can't sneak through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jwt.verify(token, process.env.JWT_SECRET || '', (err: VerifyErrors | null, payload: any) => {
    if (err) {
      return res.status(403).send('Invalid token');
    }
    if (!payload?.authAddress || !payload?.id) {
      return res.status(403).send('Invalid token payload');
    }
    req.user = { id: payload.id, authAddress: payload.authAddress, authMethod: 'native' };
    next();
  });
};

// ── isAuthenticatedMcp: PATs only ─────────────────────────────────────
// For MCP-client endpoints. Token MUST have the required scopes.
// Usage: app.use('/mcp', isAuthenticatedMcp('mcp:tools'), mcpRouter)
export function isAuthenticatedMcp(...requiredScopes: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).send('Token is missing');
    }

    if (!isPatToken(token)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'This endpoint requires Personal Access Token authentication',
      });
    }

    const pat = await verifyPat(token);
    if (!pat) {
      return res.status(403).json({ error: 'invalid_token' });
    }
    const missing = requiredScopes.filter((s) => !pat.scopes.includes(s));
    if (missing.length > 0) {
      return res.status(403).json({
        error: 'insufficient_scope',
        message: `Token missing required scope(s): ${missing.join(', ')}`,
      });
    }
    req.user = { id: pat.userId, authAddress: pat.authAddress, authMethod: 'pat' };
    return next();
  };
}

// ── isAuthenticatedNativeOrMcp: native JWTs OR PATs ──────────────────
// Native JWTs pass through with no scope restriction (wallet-cookie auth).
// PATs MUST have the required scopes.
// Usage: app.use('/ai/profile', isAuthenticatedNativeOrMcp('mcp:tools'), profileRouter)
export function isAuthenticatedNativeOrMcp(...requiredScopes: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).send('Token is missing');
    }

    if (isPatToken(token)) {
      const pat = await verifyPat(token);
      if (!pat) {
        return res.status(403).json({ error: 'invalid_token' });
      }
      const missing = requiredScopes.filter((s) => !pat.scopes.includes(s));
      if (missing.length > 0) {
        return res.status(403).json({
          error: 'insufficient_scope',
          message: `Token missing required scope(s): ${missing.join(', ')}`,
        });
      }
      req.user = { id: pat.userId, authAddress: pat.authAddress, authMethod: 'pat' };
      return next();
    }

    // Internal JWT — verify against JWT_SECRET (no scope restriction)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jwt.verify(token, process.env.JWT_SECRET || '', (err: VerifyErrors | null, payload: any) => {
      if (err) {
        return res.status(403).send('Invalid token');
      }
      if (!payload?.authAddress || !payload?.id) {
        return res.status(403).send('Invalid token payload');
      }
      req.user = { id: payload.id, authAddress: payload.authAddress, authMethod: 'native' };
      next();
    });
  };
}

// Optional authentication — allows both authenticated and unauthenticated.
// Only accepts native JWTs (PATs are silently ignored — treated as anonymous).
export const optionalAuthentication = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    req.user = undefined;
    return next();
  }

  if (isPatToken(token)) {
    req.user = undefined;
    return next();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jwt.verify(token, process.env.JWT_SECRET || '', (err: VerifyErrors | null, payload: any) => {
    if (err || !payload?.authAddress || !payload?.id) {
      req.user = undefined;
    } else {
      req.user = { id: payload.id, authAddress: payload.authAddress, authMethod: 'native' };
    }
    next();
  });
};
