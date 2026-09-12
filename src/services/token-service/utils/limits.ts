// Soft-unlimited ceiling on active (non-revoked, non-expired) PATs per user.
// Set high enough that real users won't hit it; exists purely as an abuse guard
// against scripted mass-create. The market stack has no plan tiers — single cap
// for all users.
export const PAT_LIMIT = 100;

// Allowed scope set for PATs in the market stack. `mcp:tools` is shorthand for
// both read and write (kept for backward-compat with prod-stack tokens). The
// split scopes let users mint least-privilege PATs (e.g. read-only for an
// external agent that should summarize but not modify).
export const ALLOWED_PAT_SCOPES = ['mcp:tools', 'mcp:tools:read', 'mcp:tools:write'] as const;

export type AllowedPatScope = (typeof ALLOWED_PAT_SCOPES)[number];

// ── Auto tokens (in-app chat) ──────────────────────────────────────────
// Short TTL bounds the damage of a token exfiltrated via XSS; the client
// re-mints silently, so users never notice. Name is fixed so the row is
// recognisable in the DB even though the UI never lists it.
export const AUTO_PAT_TTL_MS = 60 * 60 * 1000; // 1 hour
export const AUTO_PAT_NAME = 'In-app chat';
// Per-user mint rate: generous for page reloads, hostile to scripted spam.
export const AUTO_PAT_MINTS_PER_MINUTE = 10;
// Revoked auto rows are pure noise after this — deleted opportunistically.
export const AUTO_PAT_CLEANUP_AFTER_DAYS = 7;
