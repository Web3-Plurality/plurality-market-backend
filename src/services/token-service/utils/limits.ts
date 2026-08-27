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
