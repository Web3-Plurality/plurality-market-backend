import { AppDataSource } from '../../../data-source';
import { UserAiProfile } from '../entity/user-ai-profile';
import { UserContext } from '../entity/user-context';
import { walletToBucketHashes } from '../../blockchain-service/utils/wallet-nfts';
import Logger from '../../../lib/logger';

const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);

export interface AccessResult {
  hasAccess: boolean;
  effectiveRole: 'owner' | null;
  ownerId: string | null; // userId of the row's "data namespace" creator
  isOwner: boolean; // whether the caller is treated as owner (includes NFT holder)
  isImmutable: boolean; // surface up so callers can branch on draft vs minted
}

const NO_ACCESS: AccessResult = {
  hasAccess: false,
  effectiveRole: null,
  ownerId: null,
  isOwner: false,
  isImmutable: false,
};

/**
 * Resolve a wallet's access to a bucket. Three branches:
 *
 *   - Draft (isImmutable=false): creator-owns. Match on userId.
 *
 *   - Frozen/Registered (isImmutable=true, mintedTokenId=null): the mint
 *           flow is mid-flight (tx1 may or may not have landed; tx2 hasn't).
 *           No NFT exists yet — so we can't gate on holdership. Grant the
 *           original creator access; they're the only one who can finish
 *           or cancel the mint.
 *
 *   - Minted (isImmutable=true, mintedTokenId set): the NFT is the access
 *           token. Match on walletToBucketHashes(authAddress).has(hash).
 *           The original creator loses access on sale — intentional.
 *
 * `userId` is the User-row UUID stamped on req.user by the auth middleware.
 * It is derived from the SIWE-signed JWT or the PAT row — never from a
 * header the client controls — so we can trust it for the creator check
 * without a re-lookup.
 */
export async function resolveProfileAccess(
  authAddress: string,
  userId: string,
  profileId: string,
): Promise<AccessResult> {
  if (!authAddress || !userId || !profileId) return NO_ACCESS;

  const profile = await userAiProfileRepository.findOne({
    where: { id: profileId },
    select: ['id', 'userId', 'isImmutable', 'bucketHash', 'mintedTokenId'],
  });
  if (!profile) return NO_ACCESS;

  if (!profile.isImmutable) {
    // Draft path: creator-owns. ownerId is the creator (same as caller in
    // this branch — they must match to gain access).
    if (profile.userId !== userId) return NO_ACCESS;
    return {
      hasAccess: true,
      effectiveRole: 'owner',
      ownerId: profile.userId,
      isOwner: true,
      isImmutable: false,
    };
  }

  // Frozen or registered (immutable, but mint flow not finalised): no NFT
  // exists yet so chain-of-truth gating doesn't apply. The creator retains
  // access so they can view contexts, resume tx2, or cancel.
  if (!profile.mintedTokenId) {
    if (profile.userId !== userId) return NO_ACCESS;
    return {
      hasAccess: true,
      effectiveRole: 'owner',
      ownerId: profile.userId,
      isOwner: true,
      isImmutable: true,
    };
  }

  // Minted path: chain-of-truth via NFT holdership.
  if (!profile.bucketHash) {
    Logger.warn(`[permission] minted bucket ${profileId} has no bucketHash — denying access`);
    return NO_ACCESS;
  }
  const held = await walletToBucketHashes(authAddress);
  if (!held.has(profile.bucketHash.toLowerCase())) return NO_ACCESS;

  // ownerId stays as the original creator's userId. AI-service writes are
  // blocked on immutable buckets by Phase 8's assertEditable, so no caller
  // should be using ownerId to namespace a *write* in this branch. Reads
  // are addressed by profileId, not ownerId.
  return {
    hasAccess: true,
    effectiveRole: 'owner',
    ownerId: profile.userId,
    isOwner: true,
    isImmutable: true,
  };
}

/**
 * Single-owner model: anyone with access can edit (subject to assertEditable
 * gating in Phase 8 which blocks all writes on immutable buckets).
 */
export function canEditContext(access: AccessResult, _context: UserContext, _userId: string): boolean {
  return access.hasAccess && access.isOwner;
}

/**
 * In the post-rewrite world there is one role: owner. Kept for caller-shape
 * compatibility — every minRole resolves to owner-only.
 */
export function hasMinRole(access: AccessResult, _minRole: 'viewer' | 'editor' | 'owner'): boolean {
  return access.hasAccess && access.isOwner;
}

/**
 * Throw if a bucket is immutable. Use at the top of every context-write
 * handler in Phase 8. Pulled into this module so all permission logic lives
 * in one file.
 */
export class ImmutableBucketError extends Error {
  constructor(profileId: string) {
    super(`Bucket ${profileId} is immutable (minted); writes are not allowed`);
    this.name = 'ImmutableBucketError';
  }
}

export async function assertEditable(profileId: string): Promise<void> {
  const profile = await userAiProfileRepository.findOne({
    where: { id: profileId },
    select: ['id', 'isImmutable'],
  });
  if (!profile) {
    // Caller's permission check should already have caught this; the assert
    // is defense-in-depth so missing rows aren't silently treated as editable.
    throw new ImmutableBucketError(profileId);
  }
  if (profile.isImmutable) {
    throw new ImmutableBucketError(profileId);
  }
}
