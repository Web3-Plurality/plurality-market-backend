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
 *   skillHash     = user_ai_profile.skillHash     (SHA-256 of the normalized
 *                                                skill instructions; only
 *                                                present when the creator
 *                                                wrote a custom skill)
 *
 *   bucketHash    = SHA-256( [skillHash ||] contextHash_1 || ... || contextHash_n )
 *
 *   ordering      = skillHash FIRST (when present), then contexts
 *                   ORDER BY createdAt ASC, contextId ASC
 *                   — contextId is the tiebreaker so two contexts inserted
 *                     in the same millisecond still hash deterministically.
 *
 *   A bucket without a skill hashes exactly as before the skill feature:
 *   the skill element is simply absent, so existing hashes are unchanged.
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
 * Returns null when the bucket has neither hashable contexts nor a skill.
 *
 * `skillHash`: pass the skill hash from the profile snapshot the caller is
 * working with (prepare-registration) so the hash and the registered batch
 * derive from the same data. When omitted it is read from the DB.
 */
export async function computeFromProfile(profileId: string, skillHash?: string | null): Promise<string | null> {
  let skill: string | null;
  if (skillHash === undefined) {
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId },
      select: ['id', 'skillHash'],
    });
    skill = profile?.skillHash ?? null;
  } else {
    skill = skillHash;
  }
  const hashes = await orderedHashes(profileId, skill);
  if (hashes.length === 0) return null;
  return computeBucketHash(hashes);
}

/**
 * Canonical ordered hash list for a bucket: the skill hash first (when the
 * bucket has a custom skill), then every context contentHash in
 * (createdAt ASC, contextId ASC) order. Contexts without a contentHash are
 * skipped (very old rows, or a write that errored before the hash was
 * stamped): the bucketHash represents verifiable content only.
 */
async function orderedHashes(profileId: string, skillHash: string | null): Promise<string[]> {
  const contexts = await userContextRepository.find({
    where: { profileId },
    order: { createdAt: 'ASC', contextId: 'ASC' },
    select: ['contextId', 'contentHash', 'createdAt'],
  });
  const hashes = contexts.map((c) => c.contentHash).filter((h): h is string => typeof h === 'string' && h.length > 0);
  if (skillHash) hashes.unshift(skillHash);
  return hashes;
}

/**
 * Fetch the bucket's skill hash + contexts in canonical order, recompute the
 * bucketHash, and persist it on user_ai_profile.bucketHash. Returns the new
 * hash (or null if the bucket has neither contexts nor a skill yet).
 * Called after every context add/delete AND after every skill save/delete.
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

  // Canonical ordering (skill first, then contexts). Must match the rule
  // documented at the top of this file.
  const hashes = await orderedHashes(profileId, profile.skillHash ?? null);

  const bucketHash = hashes.length === 0 ? null : computeBucketHash(hashes);

  // Conditional UPDATE of the single column, guarded on isImmutable=false:
  // save(profile) would write the whole row we loaded above back, which can
  // un-freeze a bucket that prepare-registration froze in between.
  const updated = await userAiProfileRepository.update({ id: profileId, isImmutable: false }, { bucketHash });
  if (!updated.affected) {
    throw new Error(`bucket-hash: refusing to recompute hash for immutable bucket ${profileId}`);
  }
  return bucketHash;
}
