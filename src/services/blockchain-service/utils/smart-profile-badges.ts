import { ethers } from 'ethers';
import https from 'https';
import axios from 'axios';
import { PrivateData } from '@ethereum-attestation-service/eas-sdk';
import Logger from '../../../lib/logger';

/**
 * Server-side verification of a smart-profile platform disclosure.
 *
 * Input: the creator's wallet, their private attestation UID on Sapphire, and
 * an EAS MerkleMultiProof whose leaves are connected-platform records
 * ({platformType, userPlatformId, username} JSON + per-leaf salt), produced by
 * sp-api's /smart-profiles/disclosure endpoint.
 *
 * We trust NOTHING from the caller: the attestation is read from the chain
 * and must (a) name the wallet as recipient, (b) use the smart-profile
 * private schema, (c) be unrevoked and unexpired; the proof must verify
 * against the Merkle root committed inside that attestation; and each leaf's
 * name must match the platformType inside its own JSON value. sp-api is just
 * a proof builder here — a forged or replayed proof fails on-chain
 * verification, so the only wallet that can produce a passing disclosure is
 * the one the attestation was issued to.
 */

const EAS_ABI = [
  'function getAttestation(bytes32 uid) external view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))',
];

export interface VerifiedBadge {
  platformType: string;
  username: string | null;
  userPlatformId: string | null;
}

export interface DisclosureVerification {
  ok: boolean;
  error?: string;
  badges?: VerifiedBadge[];
}

const MAX_BADGES = 20;

/**
 * Require the disclosed attestation to be the wallet's LATEST one, per
 * sp-api's public attestation index. Without this, ANY unrevoked historical
 * attestation stays badge-material forever (sp-api never revokes superseded
 * attestations) — including ones minted before a trust fix upstream, or ones
 * from before a platform was disconnected. Trust direction is sound: a lying
 * index can only DENY a badge (recipient/schema/root are still proven
 * on-chain above), never forge one.
 *
 * Skipped with a warning when SMART_PROFILE_API_URL is unset; any other
 * failure (index unreachable, wallet unknown, UID mismatch) rejects.
 */
async function assertLatestAttestation(
  wallet: string,
  privateAttestationUID: string,
): Promise<{ ok: boolean; error?: string }> {
  const base = (process.env.SMART_PROFILE_API_URL || '').replace(/\/$/, '');
  if (!base) {
    Logger.warn('[badges] SMART_PROFILE_API_URL unset — skipping latest-attestation check');
    return { ok: true };
  }
  try {
    const res = await axios.get(`${base}/profile-map/smart-profiles/attestation-index/${wallet}`, {
      timeout: 5000,
      validateStatus: (s) => s === 200 || s === 404,
      // Local dev runs sp-api on a self-signed cert.
      httpsAgent:
        process.env.SMART_PROFILE_API_INSECURE_TLS === '1'
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined,
    });
    if (res.status === 404) {
      return { ok: false, error: 'No attestation is indexed for this wallet' };
    }
    const latest = (res.data?.data?.privateAttestationUID || '').toLowerCase();
    if (!latest) {
      return { ok: false, error: 'The attestation index has no private attestation for this wallet' };
    }
    if (latest !== privateAttestationUID.toLowerCase()) {
      return {
        ok: false,
        error: 'This disclosure is not from the wallet\'s latest attestation; re-attach badges with a fresh disclosure',
      };
    }
    return { ok: true };
  } catch (err) {
    Logger.warn(`[badges] latest-attestation lookup failed: ${(err as Error).message}`);
    return { ok: false, error: 'Could not confirm the latest attestation; try again shortly' };
  }
}

export async function verifyPlatformDisclosure(
  wallet: string,
  privateAttestationUID: string,
  proof: unknown,
): Promise<DisclosureVerification> {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  const easAddress = process.env.SAPPHIRE_EAS_ADDRESS;
  const privateSchemaUID = process.env.SAPPHIRE_PRIVATE_SCHEMA_UID;
  if (!rpcUrl || !easAddress || !privateSchemaUID) {
    return { ok: false, error: 'Badge verification is not configured' };
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateAttestationUID)) {
    return { ok: false, error: 'Invalid attestation UID' };
  }
  const p = proof as { leaves?: unknown; proof?: unknown; proofFlags?: unknown } | null;
  if (!p || !Array.isArray(p.leaves) || !Array.isArray(p.proof) || !Array.isArray(p.proofFlags)) {
    return { ok: false, error: 'Malformed proof' };
  }
  if (p.leaves.length === 0 || p.leaves.length > MAX_BADGES) {
    return { ok: false, error: `Proof must disclose 1-${MAX_BADGES} platforms` };
  }

  // 1) Read the attestation from the chain.
  let attestation: {
    schema: string;
    expirationTime: bigint;
    revocationTime: bigint;
    recipient: string;
    data: string;
  };
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const eas = new ethers.Contract(easAddress, EAS_ABI, provider);
    attestation = await eas.getAttestation(privateAttestationUID);
  } catch (err) {
    Logger.warn(`[badges] attestation read failed: ${(err as Error).message}`);
    return { ok: false, error: 'Could not read attestation from chain' };
  }

  if (!attestation || attestation.recipient === ethers.ZeroAddress) {
    return { ok: false, error: 'Attestation not found' };
  }
  if (attestation.recipient.toLowerCase() !== wallet.toLowerCase()) {
    return { ok: false, error: 'Attestation was not issued to this wallet' };
  }
  if (attestation.schema.toLowerCase() !== privateSchemaUID.toLowerCase()) {
    return { ok: false, error: 'Attestation uses a different schema' };
  }
  if (attestation.revocationTime !== BigInt(0)) {
    return { ok: false, error: 'Attestation has been revoked' };
  }
  if (attestation.expirationTime !== BigInt(0) && attestation.expirationTime < BigInt(Math.floor(Date.now() / 1000))) {
    return { ok: false, error: 'Attestation has expired' };
  }

  // 1b) The attestation must also be the wallet's LATEST (see helper doc) —
  // checked before proof verification so a stale disclosure gets a precise
  // error instead of a generic proof failure.
  const latestCheck = await assertLatestAttestation(wallet, privateAttestationUID);
  if (!latestCheck.ok) {
    return { ok: false, error: latestCheck.error };
  }

  // 2) Extract the committed Merkle root (schema: bytes32 privateDataRoot, string databasePointer).
  let root: string;
  try {
    const [decodedRoot] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32', 'string'], attestation.data);
    root = decodedRoot as string;
  } catch {
    return { ok: false, error: 'Could not decode attestation data' };
  }

  // 3) Verify the multi-proof against that root.
  try {
    if (!PrivateData.verifyMultiProof(root, p as never)) {
      return { ok: false, error: 'Proof does not match the on-chain commitment' };
    }
  } catch (err) {
    Logger.warn(`[badges] proof verification threw: ${(err as Error).message}`);
    return { ok: false, error: 'Proof verification failed' };
  }

  // 4) Parse the disclosed leaves into badges. Leaf integrity is already
  // guaranteed by the proof; here we only sanity-check internal consistency.
  const badges: VerifiedBadge[] = [];
  const seen = new Set<string>();
  for (const leaf of p.leaves as Array<{ name?: unknown; value?: unknown }>) {
    if (typeof leaf?.name !== 'string' || typeof leaf?.value !== 'string') {
      return { ok: false, error: 'Malformed proof leaf' };
    }
    let parsed: { platformType?: unknown; userPlatformId?: unknown; username?: unknown };
    try {
      parsed = JSON.parse(leaf.value);
    } catch {
      return { ok: false, error: `Leaf for ${leaf.name} is not a platform record` };
    }
    if (typeof parsed?.platformType !== 'string' || parsed.platformType.toLowerCase() !== leaf.name.toLowerCase()) {
      // A credential leaf (interests/badges/...) or mismatched record —
      // refuse rather than mint a badge from a non-platform disclosure.
      return { ok: false, error: `Leaf ${leaf.name} is not a connected-platform record` };
    }
    const key = parsed.platformType.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const username = typeof parsed.username === 'string' && parsed.username.trim() ? parsed.username.slice(0, 255) : null;
    const userPlatformId =
      typeof parsed.userPlatformId === 'string' && parsed.userPlatformId.trim()
        ? parsed.userPlatformId.slice(0, 255)
        : null;
    // A leaf with neither a username nor a platform id asserts nothing
    // ("controls SOME account on this platform") — attested empties exist
    // from an old OAuth bug that connected profiles whose identity fetch
    // had failed. Skip rather than badge them; reconnect + re-attest fixes.
    if (!username && !userPlatformId) {
      Logger.warn(`[badges] skipping identity-less ${key} leaf for ${wallet} — reconnect the platform and re-attest`);
      continue;
    }
    badges.push({
      platformType: parsed.platformType.slice(0, 50),
      username,
      userPlatformId,
    });
  }

  return { ok: true, badges };
}
