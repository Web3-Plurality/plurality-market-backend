import jwt, { VerifyErrors } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import * as dotenv from 'dotenv';
import { Request, Response, NextFunction } from 'express';
import { COOKIE_NAME } from '../../auth-service/utils/cookie';
import { AppDataSource } from '../../../data-source';
import { PersonalAccessToken } from '../../token-service/entity/personal-access-token';
import { hashToken, isPatToken } from '../../token-service/utils/token-utils';

dotenv.config();

// ── Hydra JWKS client (cached, rate-limited) ──────────────────────────
const HYDRA_ISSUER = process.env.HYDRA_ISSUER || 'http://localhost:5050';
const HYDRA_JWKS_URI =
  process.env.HYDRA_JWKS_URI || `${process.env.HYDRA_PUBLIC_URL || 'http://localhost:4444'}/.well-known/jwks.json`;

const hydraJwks = jwksClient({
  jwksUri: HYDRA_JWKS_URI,
  cache: true,
  cacheMaxAge: 3600000, // 1 hour
  rateLimit: true,
  jwksRequestsPerMinute: 5,
});

function getHydraSigningKey(header: jwt.JwtHeader, callback: (err: Error | null, key?: string) => void): void {
  hydraJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

// ── Token extraction helper ────────────────────────────────────────────
function extractToken(req: Request): string | undefined {
  // Try HttpOnly cookie first (web app)
  let token = req.cookies?.[COOKIE_NAME];
  // Fall back to Authorization header (extension/API/MCP clients)
  if (!token) {
    token = req?.headers?.authorization && req?.headers?.authorization.split(' ')[1];
  }
  return token;
}

// ── Check if a token is a Hydra JWT (has matching issuer) ──────────────
function isHydraToken(token: string): boolean {
  try {
    const decoded = jwt.decode(token, { complete: true });
    return (
      decoded?.payload != null &&
      typeof decoded.payload === 'object' &&
      'iss' in decoded.payload &&
      decoded.payload.iss === HYDRA_ISSUER
    );
  } catch {
    return false;
  }
}

// ── Verify Hydra JWT via JWKS ──────────────────────────────────────────
function verifyHydraToken(token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getHydraSigningKey, { issuer: HYDRA_ISSUER, algorithms: ['RS256'] }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

// ── Verify a Personal Access Token (PAT) against the DB ────────────────
async function verifyPat(plaintext: string): Promise<{ userId: string; scopes: string[] } | null> {
  const repo = AppDataSource.getRepository(PersonalAccessToken);
  const hash = hashToken(plaintext);
  const token = await repo.findOne({ where: { tokenHash: hash } });
  if (!token) return null;
  const now = new Date();
  if (token.revokedAt && token.revokedAt <= now) return null;
  if (token.expiresAt && token.expiresAt < now) return null;
  // Fire-and-forget last_used update — never block the hot path
  repo.update(token.id, { lastUsedAt: now }).catch(() => undefined);
  return { userId: token.userId, scopes: token.scopes };
}

// ── isAuthenticated: internal JWTs only (secure default) ─────────────
// Rejects Hydra tokens — use isAuthenticatedWithHydra for endpoints
// that need to accept OAuth tokens from MCP or other third-party clients.
export const isAuthenticated = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).send('Token is missing');
  }

  if (isHydraToken(token)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint does not accept OAuth tokens',
    });
  }

  if (isPatToken(token)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'This endpoint does not accept Personal Access Tokens',
    });
  }

  // Internal JWT — verify against JWT_SECRET
  jwt.verify(token, process.env.JWT_SECRET || '', (err: VerifyErrors | null, user: any) => {
    if (err) {
      return res.status(403).send('Invalid token');
    }
    req.user = { ...(user || {}), authMethod: 'native' };
    next();
  });
};

// ── isAuthenticatedMcp: accepts OAuth (Hydra) JWTs or PATs ───────────
// Rejects native JWTs — for MCP-client endpoints only.
// Both token types MUST have the required scopes.
// Usage: app.use('/mcp', isAuthenticatedMcp('mcp:tools'), mcpRouter)
export function isAuthenticatedMcp(...requiredScopes: string[]) {
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
      req.user = { id: pat.userId, authMethod: 'pat' };
      return next();
    }

    if (!isHydraToken(token)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'This endpoint requires OAuth or PAT authentication',
      });
    }

    try {
      const decoded = await verifyHydraToken(token);

      const tokenScopes: string[] = decoded.scp || [];
      const missing = requiredScopes.filter((s) => !tokenScopes.includes(s));
      if (missing.length > 0) {
        return res.status(403).json({
          error: 'insufficient_scope',
          message: `Token missing required scope(s): ${missing.join(', ')}`,
        });
      }

      req.user = { id: decoded.sub, ...decoded, authMethod: 'hydra' };
      next();
    } catch (err) {
      return res.status(403).send('Invalid OAuth token');
    }
  };
}

// ── isAuthenticatedNativeOrMcp: accepts native JWTs, OAuth JWTs, or PATs ──
// Native JWTs pass through with no scope restriction.
// OAuth tokens and PATs MUST have the required scopes — rejects if missing.
// Usage: app.use('/ai/profile', isAuthenticatedNativeOrMcp('mcp:tools'), profileRouter)
export function isAuthenticatedNativeOrMcp(...requiredScopes: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).send('Token is missing');
    }

    if (isPatToken(token)) {
      // Personal Access Token — DB-backed bearer token for headless agents
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
      req.user = { id: pat.userId, authMethod: 'pat' };
      return next();
    }

    if (isHydraToken(token)) {
      // Hydra JWT — verify signature + enforce scopes
      try {
        const decoded = await verifyHydraToken(token);

        // Scope check: Hydra tokens must have all required scopes
        const tokenScopes: string[] = decoded.scp || [];
        const missing = requiredScopes.filter((s) => !tokenScopes.includes(s));
        if (missing.length > 0) {
          return res.status(403).json({
            error: 'insufficient_scope',
            message: `Token missing required scope(s): ${missing.join(', ')}`,
          });
        }

        // Map Hydra `sub` claim to req.user.id for compatibility with existing code
        req.user = { id: decoded.sub, ...decoded, authMethod: 'hydra' };
        next();
      } catch (err) {
        return res.status(403).send('Invalid Hydra token');
      }
    } else {
      // Internal JWT — verify against JWT_SECRET (no scope restriction)
      jwt.verify(token, process.env.JWT_SECRET || '', (err: VerifyErrors | null, user: any) => {
        if (err) {
          return res.status(403).send('Invalid token');
        }
        req.user = { ...(user || {}), authMethod: 'native' };
        next();
      });
    }
  };
}

// Optional authentication middleware - allows both authenticated and unauthenticated requests
// Only accepts internal JWTs (Hydra tokens and PATs are silently ignored — treated as unauthenticated)
export const optionalAuthentication = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    req.user = undefined;
    return next();
  }

  if (isHydraToken(token)) {
    // Hydra tokens are not accepted on optional-auth endpoints
    req.user = undefined;
    return next();
  }

  if (isPatToken(token)) {
    // PATs are not accepted on optional-auth endpoints
    req.user = undefined;
    return next();
  }

  jwt.verify(token, process.env.JWT_SECRET || '', (err: VerifyErrors | null, user: any) => {
    if (err) {
      req.user = undefined;
    } else {
      req.user = { ...(user || {}), authMethod: 'native' };
    }
    next();
  });
};
