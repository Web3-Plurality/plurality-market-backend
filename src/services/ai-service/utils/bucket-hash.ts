import { createHash } from 'crypto';
import { AppDataSource } from '../../../data-source';
import { UserAiProfile } from '../entity/user-ai-profile';
import { UserContext } from '../entity/user-context';
import Logger from '../../../lib/logger';

/**
 * Bucket-hash module: computes and persists the SHA-256 Merkle hash that
 * uniquely identifies the contents of a bucket. Used as the on-chain
 * identifier when the bucket is minted.
 *
 *   contextHash_i = user_context.contentHash    (SHA-256 of the raw content
 *                                                — set at write time by
 *                                                hashContent() in
 *                                                blockchain-service/utils)
 *
 *   bucketHash    = SHA-256( contextHash_1 || contextHash_2 || ... || contextHash_n )
 *
 *   ordering      = ORDER BY createdAt ASC, contextId ASC
 *                   — contextId is the tiebreaker so two contexts inserted
 *                     in the same millisecond still hash deterministically.
 *
 * Output format: "0x" + 64 hex chars (66 chars total). This matches both the
 * Postgres column (varchar(66)) and the Solidity bytes32 expected by
 * PluralityMemoryNFT.mintBucket(bytes32, string).
 */

const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);
const userContextRepository = AppDataSource.getRepository(UserContext);

/**
 * Pure: hash an already-ordered list of context hashes. Each hash must be a
 * `0x`-prefixed hex string (66 chars total). The `0x` prefix is stripped
 * before concatenation so the input length to SHA-256 is exactly 32 * n bytes.
 */
export function computeBucketHash(orderedContextHashes: string[]): string {
  const hasher = createHash('sha256');
  for (const h of orderedContextHashes) {
    if (!h || !h.startsWith('0x') || h.length !== 66) {
      // A malformed contentHash here would corrupt the bucketHash silently —
      // fail loudly so we catch broken data before it pins the chain.
      throw new Error(`bucket-hash: malformed contentHash "${h}" (expected 0x-prefixed 64-hex)`);
    }
    hasher.update(Buffer.from(h.slice(2), 'hex'));
  }
  return '0x' + hasher.digest('hex');
}

/**
 * Pure: read the bucket's contexts in canonical order and compute the hash
 * WITHOUT persisting it. Use when you need the hash for a read-only check
 * (e.g. "is this already on-chain?") or when the caller will save in a
 * single coordinated write. Works regardless of `isImmutable` — the hash
 * is purely a function of content.
 *
 * Returns null when the bucket has no hashable contexts.
 */
export async function computeFromProfile(profileId: string): Promise<string | null> {
  const contexts = await userContextRepository.find({
    where: { profileId },
    order: { createdAt: 'ASC', contextId: 'ASC' },
    select: ['contextId', 'contentHash', 'createdAt'],
  });
  const hashes = contexts.map((c) => c.contentHash).filter((h): h is string => typeof h === 'string' && h.length > 0);
  if (hashes.length === 0) return null;
  return computeBucketHash(hashes);
}

/**
 * Fetch the bucket's contexts in canonical order, recompute the bucketHash,
 * and persist it on user_ai_profile.bucketHash. Returns the new hash (or
 * null if the bucket has no contexts yet).
 *
 * Must NOT be called on an immutable bucket — callers gate that upstream via
 * assertEditable. As a defense-in-depth check this function also throws if it
 * finds isImmutable=true, so a stray invocation can't silently re-stamp the
 * hash of a minted bucket.
 */
export async function recomputeAndStore(profileId: string): Promise<string | null> {
  const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
  if (!profile) {
    Logger.warn(`[bucket-hash] recomputeAndStore: profile ${profileId} not found`);
    return null;
  }
  if (profile.isImmutable) {
    throw new Error(`bucket-hash: refusing to recompute hash for immutable bucket ${profileId}`);
  }

  // Canonical ordering — must match the rule documented at the top of this file.
  const contexts = await userContextRepository.find({
    where: { profileId },
    order: { createdAt: 'ASC', contextId: 'ASC' },
    select: ['contextId', 'contentHash', 'createdAt'],
  });

  // Skip any context that never got a contentHash (very old rows, or a write
  // that errored before the hash was stamped). The bucketHash represents
  // verifiable content only.
  const hashes = contexts.map((c) => c.contentHash).filter((h): h is string => typeof h === 'string' && h.length > 0);

  if (hashes.length === 0) {
    profile.bucketHash = null;
    await userAiProfileRepository.save(profile);
    return null;
  }

  const bucketHash = computeBucketHash(hashes);
  profile.bucketHash = bucketHash;
  await userAiProfileRepository.save(profile);
  return bucketHash;
}
