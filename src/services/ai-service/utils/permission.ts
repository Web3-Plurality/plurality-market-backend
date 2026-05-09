import { AppDataSource } from '../../../data-source';
import { UserAiProfile } from '../entity/user-ai-profile';
import { ProfileAccess } from '../entity/profile-access';
import { UserContext } from '../entity/user-context';

const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);
const profileAccessRepository = AppDataSource.getRepository(ProfileAccess);

export interface AccessResult {
  hasAccess: boolean;
  effectiveRole: 'owner' | 'editor' | 'viewer' | null;
  ownerId: string | null;
  isOwner: boolean;
  shareId?: string;
}

const NO_ACCESS: AccessResult = {
  hasAccess: false,
  effectiveRole: null,
  ownerId: null,
  isOwner: false,
};

/**
 * Resolve a user's access level on a profile.
 * 1. Owner check (profile.userId === userId)
 * 2. profile_access lookup
 * 3. Default: no access
 */
export async function resolveProfileAccess(userId: string, profileId: string): Promise<AccessResult> {
  // 1. Check if user is the owner
  const profile = await userAiProfileRepository.findOne({
    where: { id: profileId },
    select: ['id', 'userId'],
  });

  if (!profile) {
    return NO_ACCESS;
  }

  if (profile.userId === userId) {
    return {
      hasAccess: true,
      effectiveRole: 'owner',
      ownerId: userId,
      isOwner: true,
    };
  }

  // 2. Check profile_access
  const share = await profileAccessRepository.findOne({
    where: { profileId, grantedToId: userId },
  });

  if (share) {
    return {
      hasAccess: true,
      effectiveRole: share.role as 'editor' | 'viewer',
      ownerId: profile.userId,
      isOwner: false,
      shareId: share.id,
    };
  }

  // 3. No access
  return NO_ACCESS;
}

/**
 * Check if a user can edit (update/delete) a specific context.
 * - Owner can edit anything.
 * - Editor can only edit contexts they added (addedBy === userId).
 * - Viewer cannot edit.
 */
export function canEditContext(access: AccessResult, context: UserContext, userId: string): boolean {
  if (!access.hasAccess) return false;
  if (access.isOwner) return true;
  if (access.effectiveRole === 'editor' && context.addedBy === userId) return true;
  return false;
}

/**
 * Check if a user has at least the required role level on a bucket.
 */
export function hasMinRole(access: AccessResult, minRole: 'viewer' | 'editor' | 'owner'): boolean {
  if (!access.hasAccess) return false;

  const roleHierarchy: Record<string, number> = {
    viewer: 1,
    editor: 2,
    owner: 3,
  };

  const userLevel = roleHierarchy[access.effectiveRole || ''] || 0;
  const requiredLevel = roleHierarchy[minRole] || 0;

  return userLevel >= requiredLevel;
}
