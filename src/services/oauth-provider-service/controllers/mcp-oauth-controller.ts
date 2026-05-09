import express, { Request, Response } from 'express';
import Logger from '../../../lib/logger';
import * as dotenv from 'dotenv';

dotenv.config();
export const mcpOAuthRouter = express.Router();

const HYDRA_PUBLIC_URL = process.env.HYDRA_PUBLIC_URL || 'http://localhost:4444';
const MCP_RESOURCE_URL = process.env.MCP_RESOURCE_URL || 'http://localhost:5050';

// ── OAuth Protected Resource Metadata (RFC 9728) ─────────────────────
// Required by MCP spec — tells clients where to find the authorization server

function oauthProtectedResourceHandler(_req: Request, res: Response) {
  // #swagger.tags = ['OAuth-Provider']
  res.json({
    resource: MCP_RESOURCE_URL,
    authorization_servers: [MCP_RESOURCE_URL],
    scopes_supported: ['openid', 'offline_access', 'offline', 'mcp:tools'],
    bearer_methods_supported: ['header'],
  });
}

mcpOAuthRouter.get('/.well-known/oauth-protected-resource', oauthProtectedResourceHandler);
mcpOAuthRouter.get('/.well-known/oauth-protected-resource/mcp', oauthProtectedResourceHandler);

// ── OIDC Discovery / Authorization Server Metadata ───────────────────
// Fetches metadata from Hydra (internal Docker DNS) and injects registration_endpoint

async function fetchAndPatchOidcMetadata(_req: Request, res: Response) {
  // #swagger.tags = ['OAuth-Provider']
  try {
    const resp = await fetch(`${HYDRA_PUBLIC_URL}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return res.status(502).json({ error: `Hydra returned ${resp.status}`, body });
    }

    const metadata = await resp.json();
    if (!metadata.registration_endpoint) {
      metadata.registration_endpoint = `${MCP_RESOURCE_URL}/register`;
    }
    return res.json(metadata);
  } catch (err: any) {
    Logger.error(`[MCP OAuth] OIDC metadata fetch failed: ${err.message}`);
    return res.status(502).json({ error: `Failed to reach Hydra: ${err.message}` });
  }
}

mcpOAuthRouter.get('/.well-known/oauth-authorization-server', fetchAndPatchOidcMetadata);
mcpOAuthRouter.get('/.well-known/oauth-authorization-server/mcp', fetchAndPatchOidcMetadata);

mcpOAuthRouter.get('/.well-known/openid-configuration', fetchAndPatchOidcMetadata);
mcpOAuthRouter.get('/.well-known/openid-configuration/mcp', fetchAndPatchOidcMetadata);

// ── DCR Proxy (sanitizes request/response for Hydra <-> MCP SDK) ─────
// Workaround for: https://github.com/modelcontextprotocol/typescript-sdk/issues/754
//
// Request:  MCP SDK sends null for optional fields -> Hydra rejects (expects array or omitted)
// Response: Hydra returns null for optional fields -> MCP SDK Zod schema rejects (expects array)
// Fix:      Strip nulls from request, coerce array fields; strip nulls from response.

const DCR_ARRAY_FIELDS = new Set([
  'contacts',
  'grant_types',
  'response_types',
  'redirect_uris',
  'post_logout_redirect_uris',
  'request_uris',
  'allowed_cors_origins',
  'audience',
]);

const DCR_URI_FIELDS = new Set([
  'client_uri',
  'logo_uri',
  'policy_uri',
  'tos_uri',
  'jwks_uri',
  'backchannel_logout_uri',
  'frontchannel_logout_uri',
  'sector_identifier_uri',
]);

function sanitizeDcrRequest(body: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if (DCR_URI_FIELDS.has(key) && value === '') continue;
    if (DCR_ARRAY_FIELDS.has(key) && !Array.isArray(value)) {
      sanitized[key] = value ? [value] : [];
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitizeDcrResponse(body: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if (DCR_URI_FIELDS.has(key) && value === '') continue;
    sanitized[key] = value;
  }
  return sanitized;
}

// Scopes that all MCP clients must be allowed to request.
// `offline` is a non-standard alias for `offline_access` used by some clients
// (notably Perplexity's custom MCP connector). Included so those clients can
// complete OAuth without hitting invalid_scope.
const MCP_REQUIRED_SCOPES = ['openid', 'offline_access', 'offline', 'mcp:tools'];

async function proxyDcrToHydra(req: Request, res: Response) {
  // #swagger.tags = ['OAuth-Provider']
  try {
    let body = req.body;
    if (body && typeof body === 'object' && Object.keys(body).length > 0) {
      body = sanitizeDcrRequest(body);
    }

    // Ensure client is allowed to request MCP-required scopes
    const existing = typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [];
    const merged = [...new Set([...existing, ...MCP_REQUIRED_SCOPES])];
    body.scope = merged.join(' ');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    const resp = await fetch(`${HYDRA_PUBLIC_URL}/oauth2/register`, {
      method: req.method,
      headers,
      body: req.method !== 'GET' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      let respJson = await resp.json();
      if (respJson && typeof respJson === 'object' && !Array.isArray(respJson)) {
        respJson = sanitizeDcrResponse(respJson);
      }
      return res.status(resp.status).json(respJson);
    } else {
      const text = await resp.text();
      return res.status(resp.status).json({ raw: text });
    }
  } catch (err: any) {
    Logger.error(`[MCP OAuth] DCR proxy failed: ${err.message}`);
    return res.status(502).json({ error: `DCR proxy failed: ${err.message}` });
  }
}

mcpOAuthRouter.route('/register').get(proxyDcrToHydra).post(proxyDcrToHydra);
mcpOAuthRouter.route('/oauth2/register').get(proxyDcrToHydra).post(proxyDcrToHydra);
