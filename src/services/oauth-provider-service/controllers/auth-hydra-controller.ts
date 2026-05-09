import express, { Request, Response } from 'express';
import Logger from '../../../lib/logger';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import * as dotenv from 'dotenv';

dotenv.config();
export const authHydraRouter = express.Router();

const HYDRA_ADMIN_URL = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';

// ── Hydra Admin API helpers ──────────────────────────────────────────

interface HydraLoginRequest {
  challenge: string;
  skip: boolean;
  subject: string;
  client: { client_id: string; client_name?: string };
  requested_scope: string[];
  request_url: string;
}

interface HydraConsentRequest {
  challenge: string;
  skip: boolean;
  subject: string;
  client: { client_id: string; client_name?: string };
  requested_scope: string[];
  requested_access_token_audience: string[];
}

interface HydraRedirectResponse {
  redirect_to: string;
}

async function hydraGet<T>(path: string): Promise<T> {
  const res = await fetch(`${HYDRA_ADMIN_URL}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hydra ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

async function hydraPut<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${HYDRA_ADMIN_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hydra PUT ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Routes ───────────────────────────────────────────────────────────

// GET /login — fetch login request info from Hydra
// No auth required (user hasn't logged in yet)
authHydraRouter.get('/login', async (req: Request, res: Response) => {
  // #swagger.tags = ['OAuth-Provider']
  try {
    const challenge = req.query.login_challenge as string;
    if (!challenge) {
      return res.status(400).json({ error: 'login_challenge query parameter is required' });
    }

    const loginRequest = await hydraGet<HydraLoginRequest>(
      `/admin/oauth2/auth/requests/login?login_challenge=${challenge}`,
    );

    if (loginRequest.skip) {
      // User already authenticated in Hydra session — auto-accept
      const acceptResponse = await hydraPut<HydraRedirectResponse>(
        `/admin/oauth2/auth/requests/login/accept?login_challenge=${challenge}`,
        { subject: loginRequest.subject, remember: true, remember_for: 3600 },
      );
      return res.json({ redirect_to: acceptResponse.redirect_to });
    }

    // Return info so frontend can show login form
    return res.json({
      challenge: loginRequest.challenge,
      requested_scope: loginRequest.requested_scope,
      client: loginRequest.client,
    });
  } catch (err: any) {
    Logger.error(`[Hydra] GET /login error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /login — accept login after user authenticates
// Protected by isAuthenticated: uses req.user.id (DB UUID) as Hydra subject
authHydraRouter.post('/login', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['OAuth-Provider']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  try {
    const loginChallenge = req.body.login_challenge;
    if (!loginChallenge) {
      return res.status(400).json({ error: 'login_challenge is required' });
    }

    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User ID not found in token' });
    }

    Logger.info(`[Hydra] Accepting login for user ${userId}, challenge ${loginChallenge}`);

    const acceptResponse = await hydraPut<HydraRedirectResponse>(
      `/admin/oauth2/auth/requests/login/accept?login_challenge=${loginChallenge}`,
      { subject: userId, remember: true, remember_for: 3600 },
    );

    return res.json({ redirect_to: acceptResponse.redirect_to });
  } catch (err: any) {
    Logger.error(`[Hydra] POST /login error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// GET /consent — fetch consent request info from Hydra
authHydraRouter.get('/consent', async (req: Request, res: Response) => {
  // #swagger.tags = ['OAuth-Provider']
  try {
    const challenge = req.query.consent_challenge as string;
    if (!challenge) {
      return res.status(400).json({ error: 'consent_challenge query parameter is required' });
    }

    const consentRequest = await hydraGet<HydraConsentRequest>(
      `/admin/oauth2/auth/requests/consent?consent_challenge=${challenge}`,
    );

    if (consentRequest.skip) {
      // Consent previously granted and remembered — auto-accept
      const acceptResponse = await hydraPut<HydraRedirectResponse>(
        `/admin/oauth2/auth/requests/consent/accept?consent_challenge=${challenge}`,
        {
          grant_scope: consentRequest.requested_scope,
          grant_access_token_audience: consentRequest.requested_access_token_audience,
          remember: true,
          remember_for: 3600,
          session: {
            access_token: { userId: consentRequest.subject },
          },
        },
      );
      return res.json({ redirect_to: acceptResponse.redirect_to });
    }

    return res.json({
      challenge: consentRequest.challenge,
      requested_scope: consentRequest.requested_scope,
      client: consentRequest.client,
      subject: consentRequest.subject,
    });
  } catch (err: any) {
    Logger.error(`[Hydra] GET /consent error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /consent — accept consent with selected scopes
authHydraRouter.post('/consent', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['OAuth-Provider']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  try {
    const consentChallenge = req.body.consent_challenge;
    const grantScope = req.body.grant_scope;
    if (!consentChallenge) {
      return res.status(400).json({ error: 'consent_challenge is required' });
    }
    if (!Array.isArray(grantScope)) {
      return res.status(400).json({ error: 'grant_scope must be an array' });
    }

    // Re-fetch consent request to get audience and subject
    const consentRequest = await hydraGet<HydraConsentRequest>(
      `/admin/oauth2/auth/requests/consent?consent_challenge=${consentChallenge}`,
    );

    const userId = (req as any).user?.id;
    Logger.info(`[Hydra] Accepting consent for user ${userId}, challenge ${consentChallenge}`);

    const acceptResponse = await hydraPut<HydraRedirectResponse>(
      `/admin/oauth2/auth/requests/consent/accept?consent_challenge=${consentChallenge}`,
      {
        grant_scope: grantScope,
        grant_access_token_audience: consentRequest.requested_access_token_audience,
        remember: true,
        remember_for: 3600,
        session: {
          access_token: { userId: consentRequest.subject },
        },
      },
    );

    return res.json({ redirect_to: acceptResponse.redirect_to });
  } catch (err: any) {
    Logger.error(`[Hydra] POST /consent error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// POST /consent/reject — reject consent
authHydraRouter.post('/consent/reject', async (req: Request, res: Response) => {
  // #swagger.tags = ['OAuth-Provider']
  try {
    const consentChallenge = req.body.consent_challenge;
    if (!consentChallenge) {
      return res.status(400).json({ error: 'consent_challenge is required' });
    }

    const rejectResponse = await hydraPut<HydraRedirectResponse>(
      `/admin/oauth2/auth/requests/consent/reject?consent_challenge=${consentChallenge}`,
      {
        error: 'access_denied',
        error_description: 'The user denied the consent request',
      },
    );

    return res.json({ redirect_to: rejectResponse.redirect_to });
  } catch (err: any) {
    Logger.error(`[Hydra] POST /consent/reject error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});
