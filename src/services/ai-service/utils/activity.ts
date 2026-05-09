import { AppDataSource } from '../../../data-source';
import { ActivityLog } from '../entity/activity-log';
import Logger from '../../../lib/logger';

const activityLogRepository = AppDataSource.getRepository(ActivityLog);

/**
 * Log an activity on a profile (fire-and-forget — should not block the main request).
 */
export function logActivity(
  profileId: string,
  actorId: string,
  action: string,
  opts?: {
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, any>;
  },
): void {
  const entry = activityLogRepository.create({
    profileId,
    actorId,
    action,
    targetType: opts?.targetType || null,
    targetId: opts?.targetId || null,
    metadata: opts?.metadata || null,
  });

  activityLogRepository.save(entry).catch((err) => {
    Logger.warn(`[ACTIVITY] Failed to log activity: ${err.message}`);
  });
}
