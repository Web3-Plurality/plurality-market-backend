import express, { Request, Response } from 'express';
import { AppDataSource } from '../../../data-source';
import { User } from '../entity/user';
import { isAuthenticated } from '../middlewares/auth-middleware';
import Logger from '../../../lib/logger';

export const userAccountRouter = express.Router();

const userRepository = AppDataSource.getRepository(User);

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
      authAddress: user.authAddress,
      loginType: user.loginType,
    });
  } catch (error) {
    Logger.error('[USER-ACCOUNT] Error fetching user info:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
