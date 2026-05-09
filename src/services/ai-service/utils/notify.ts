import { AppDataSource } from '../../../data-source';
import { Notification } from '../entity/notification';
import { ProfileAccess } from '../entity/profile-access';
import { UserAiProfile } from '../entity/user-ai-profile';
import Logger from '../../../lib/logger';

const notificationRepository = AppDataSource.getRepository(Notification);
const profileAccessRepository = AppDataSource.getRepository(ProfileAccess);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);

/**
 * Notify all members of a shared profile (fire-and-forget).
 * Creates a notification for each user who has access (owner + grantees),
 * excluding the actor who triggered the event.
 */
export function notifyShareMembers(
  profileId: string,
  excludeUserId: string,
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, any>,
): void {
  (async () => {
    // Get the profile owner
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId },
      select: ['id', 'userId'],
    });

    // Get all grantees
    const shares = await profileAccessRepository.find({
      where: { profileId },
      select: ['grantedToId'],
    });

    // Collect all user IDs (owner + grantees), excluding the actor
    const recipientIds = new Set<string>();
    if (profile && profile.userId !== excludeUserId) {
      recipientIds.add(profile.userId);
    }
    for (const share of shares) {
      if (share.grantedToId !== excludeUserId) {
        recipientIds.add(share.grantedToId);
      }
    }

    if (recipientIds.size === 0) return;

    // Batch-create notifications
    const notifications = Array.from(recipientIds).map((userId) =>
      notificationRepository.create({
        userId,
        type,
        title,
        body: body || null,
        metadata: metadata || null,
      }),
    );

    await notificationRepository.save(notifications);
  })().catch((err) => {
    Logger.warn(`[NOTIFY] Failed to send notifications: ${err.message}`);
  });
}
