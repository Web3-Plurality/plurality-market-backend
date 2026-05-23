import express, { Request, Response } from 'express';
import axios from 'axios';
import { AppDataSource } from '../../../data-source';
import { User } from '../entity/user';
import { UserSession } from '../../auth-service/entity/user-session';
import { UserAiProfile } from '../../ai-service/entity/user-ai-profile';
import { UserContext } from '../../ai-service/entity/user-context';
import { ActivityLog } from '../../ai-service/entity/activity-log';
import { Notification } from '../../ai-service/entity/notification';
import { isAuthenticated } from '../middlewares/auth-middleware';
import { clearAuthCookie } from '../../auth-service/utils/cookie';
import Logger from '../../../lib/logger';

export const userAccountRouter = express.Router();

const userRepository = AppDataSource.getRepository(User);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);

// GET: Get user account info
userAccountRouter.get('/', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['User-Account']
  /* #swagger.security = [{
    "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await userRepository.findOne({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
      name: user.name,
      email: user.email,
      authAddress: user.authAddress,
      loginType: user.loginType,
      preferredModel: user.preferredModel || null,
    });
  } catch (error) {
    Logger.error('[USER-ACCOUNT] Error fetching user info:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH: Update user preferences (currently just preferredModel; structured
// for future additions). preferredModel = null clears the stored choice so
// the client falls back to its product default. The client validates that the
// model is available + plan-allowed before sending; we trust the string here
// and handle invalid values at read time on the client (graceful fallback).
userAccountRouter.patch('/preferences', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['User-Account']
  try {
    const userId = req?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { preferredModel } = req.body as { preferredModel?: string | null };

    // Only update fields that were explicitly provided (undefined = "leave alone").
    // Use `'preferredModel' in req.body` so passing `null` clears the value.
    const updates: Partial<User> = {};
    if ('preferredModel' in (req.body || {})) {
      if (preferredModel !== null && typeof preferredModel !== 'string') {
        return res.status(400).json({ error: 'preferredModel must be a string or null' });
      }
      if (typeof preferredModel === 'string' && preferredModel.length > 100) {
        return res.status(400).json({ error: 'preferredModel is too long' });
      }
      updates.preferredModel = preferredModel || (null as unknown as string);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await userRepository.update(userId, updates);

    return res.status(200).json({ success: true, ...updates });
  } catch (error) {
    Logger.error('[USER-ACCOUNT] Error updating preferences:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE: Delete user account and all associated data (Right to Forget)
userAccountRouter.delete('/', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['User-Account']
  /* #swagger.security = [{
    "bearerAuth": []
  }] */
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await userRepository.findOne({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    Logger.info(`[RIGHT-TO-FORGET] Initiating account deletion for user ${userId}`);

    // Step 1: Fetch all user profiles to clean up vector store
    const profiles = await userAiProfileRepository.find({ where: { userId } });

    // Step 2: Call AI service to delete vectors for each profile
    for (const profile of profiles) {
      try {
        await axios.delete(
          `${process.env.AI_SERVICE_URL}/rag/delete-all-contexts?userId=${userId}&profileId=${profile.id}`,
          {
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
            },
          },
        );
        Logger.info(`[RIGHT-TO-FORGET] Deleted vectors for profile ${profile.id}`);
      } catch (aiServiceError) {
        Logger.warn(`[RIGHT-TO-FORGET] Failed to delete vectors for profile ${profile.id}:`, aiServiceError);
      }
    }

    // Step 3: Delete all DB records in a transaction
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      // Delete activity logs where user is actor
      await queryRunner.manager.delete(ActivityLog, { actorId: userId });
      Logger.info(`[RIGHT-TO-FORGET] Deleted all activity logs for user ${userId}`);

      // Delete notifications for user
      await queryRunner.manager.delete(Notification, { userId });
      Logger.info(`[RIGHT-TO-FORGET] Deleted all notifications for user ${userId}`);

      await queryRunner.manager.delete(UserContext, { userId });
      Logger.info(`[RIGHT-TO-FORGET] Deleted all contexts for user ${userId}`);

      await queryRunner.manager.delete(UserAiProfile, { userId });
      Logger.info(`[RIGHT-TO-FORGET] Deleted all profiles for user ${userId}`);

      await queryRunner.manager.delete(UserSession, { userId });
      Logger.info(`[RIGHT-TO-FORGET] Deleted all sessions for user ${userId}`);

      await queryRunner.manager.remove(user);
      Logger.info(`[RIGHT-TO-FORGET] Deleted user record for user ${userId}`);

      await queryRunner.commitTransaction();
    } catch (dbError) {
      await queryRunner.rollbackTransaction();
      Logger.error(`[RIGHT-TO-FORGET] DB transaction failed for user ${userId}, rolled back:`, dbError);
      return res.status(500).json({ error: 'Failed to delete account data. Please retry.' });
    } finally {
      await queryRunner.release();
    }

    // Step 4: Clear auth cookie
    clearAuthCookie(res);

    res.status(200).json({
      message: 'Account and all associated data deleted successfully',
    });
  } catch (error) {
    Logger.error('[RIGHT-TO-FORGET] Error deleting user account:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
