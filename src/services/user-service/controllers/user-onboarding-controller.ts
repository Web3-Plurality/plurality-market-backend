import express, { Request, Response } from 'express';
import { AppDataSource } from '../../../data-source';
import { User } from '../entity/user';
import Logger from '../../../lib/logger';
import { isAuthenticated } from '../middlewares/auth-middleware';

export const userOnboardingRouter = express.Router();

const userRepository = AppDataSource.getRepository(User);

// Get onboarding status - check if user has completed onboarding
userOnboardingRouter.get('/status', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['User-Onboarding']
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await userRepository.findOne({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isOnboardingComplete = !!user.name;

    return res.status(200).json({
      isOnboardingComplete,
      user: {
        id: user.id,
        name: user.name || null,
        email: user.email || null,
        preferredModel: user.preferredModel || null,
      },
    });
  } catch (error: any) {
    Logger.error(`[ONBOARDING] Error getting status: ${error.message}`);
    return res.status(500).json({ error: 'Failed to get onboarding status' });
  }
});

// Update user name (complete onboarding)
userOnboardingRouter.post('/complete', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['User-Onboarding']
  try {
    const userId = req.user?.id;
    const { name } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }

    if (trimmedName.length > 50) {
      return res.status(400).json({ error: 'Name must be less than 50 characters' });
    }

    const user = await userRepository.findOne({ where: { id: userId } });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await userRepository.update(userId, { name: trimmedName });

    Logger.info(`[ONBOARDING] User ${userId} completed onboarding with name: ${trimmedName}`);

    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        name: trimmedName,
        email: user.email || null,
      },
    });
  } catch (error: any) {
    Logger.error(`[ONBOARDING] Error completing onboarding: ${error.message}`);
    return res.status(500).json({ error: 'Failed to complete onboarding' });
  }
});
