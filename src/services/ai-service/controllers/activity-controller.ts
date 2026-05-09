import express, { Request, Response } from 'express';
import { AppDataSource } from '../../../data-source';
import { ActivityLog } from '../entity/activity-log';
import { User } from '../../user-service/entity/user';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import { resolveProfileAccess } from '../utils/permission';
import Logger from '../../../lib/logger';
import { validate as isValidUUID } from 'uuid';

export const activityRouter = express.Router();

const activityLogRepository = AppDataSource.getRepository(ActivityLog);

// GET /ai/activity/profile/:profileId — Paginated activity feed (viewer+)
activityRouter.get('/profile/:profileId', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Activity']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  /* #swagger.description = 'Get paginated activity log for a profile. Requires viewer+ access.' */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid profile ID format' });
    }

    // Permission check: viewer+ can see activity
    const access = await resolveProfileAccess(userId, profileId);
    if (!access.hasAccess) {
      return res.status(404).json({ error: 'Profile not found or access denied' });
    }

    const offset = (page - 1) * limit;

    // Fetch activities with actor user info via LEFT JOIN
    const activities = await activityLogRepository
      .createQueryBuilder('a')
      .leftJoin(User, 'u', 'u.id = a.actorId')
      .select([
        'a.id AS id',
        'a.actorId AS "actorId"',
        'a.action AS action',
        'a.targetType AS "targetType"',
        'a.targetId AS "targetId"',
        'a.metadata AS metadata',
        'a.createdAt AS "createdAt"',
        'u.name AS "actorName"',
        'u.email AS "actorEmail"',
        'u.authAddress AS "actorWallet"',
      ])
      .where('a.profileId = :profileId', { profileId })
      .orderBy('a.createdAt', 'DESC')
      .offset(offset)
      .limit(limit)
      .getRawMany();

    // Get total count separately
    const totalCount = await activityLogRepository.count({ where: { profileId } });

    const mapped = activities.map((a: any) => ({
      id: a.id,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      metadata: a.metadata,
      createdAt: a.createdAt,
      actor: {
        id: a.actorId,
        name: a.actorName || null,
        email: a.actorEmail || null,
        wallet: a.actorWallet || null,
      },
    }));

    res.status(200).json({
      activities: mapped,
      total: totalCount,
      page,
      limit,
    });
  } catch (error) {
    Logger.error('Error fetching activity log:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
