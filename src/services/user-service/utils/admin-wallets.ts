// Team allowlist for curation endpoints (e.g. featuring buckets on the
// homepage slider). Sourced from the ADMIN_WALLETS env var so it can never
// be changed through the public API: adding an admin requires a deploy-side
// config change, not a database write.
//
// Format: comma-separated wallet addresses, case-insensitive.
// Empty / unset means NO admins — every curation endpoint stays closed.
export function isAdminWallet(authAddress?: string | null): boolean {
  if (!authAddress) return false;
  const allowlist = (process.env.ADMIN_WALLETS || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) return false;
  return allowlist.includes(authAddress.toLowerCase());
}
