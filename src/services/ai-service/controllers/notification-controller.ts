import express, { Request, Response } from 'express';
import { AppDataSource } from '../../../data-source';
import { Notification } from '../entity/notification';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import Logger from '../../../lib/logger';
import { validate as isValidUUID } from 'uuid';

export const notificationRouter = express.Router();

const notificationRepository = AppDataSource.getRepository(Notification);

// GET /ai/notifications — List notifications (paginated)
notificationRouter.get('/', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Notifications']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  /* #swagger.description = 'List notifications for the authenticated user. Supports pagination and unread-only filter.' */
  try {
    const userId = req?.user?.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const unreadOnly = req.query.unreadOnly === 'true';

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const offset = (page - 1) * limit;

    const where: any = { userId };
    if (unreadOnly) {
      where.isRead = false;
    }

    const [notifications, total] = await notificationRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    // Get unread count (always, regardless of filter)
    const unreadCount = await notificationRepository.count({
      where: { userId, isRead: false },
    });

    res.status(200).json({
      notifications,
      unreadCount,
      total,
      page,
      limit,
    });
  } catch (error) {
    Logger.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /ai/notifications/read-all — Mark all as read (must be before /:id/read)
notificationRouter.patch('/read-all', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Notifications']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    await notificationRepository.update({ userId, isRead: false }, { isRead: true });

    res.status(200).json({ message: 'All notifications marked as read' });
  } catch (error) {
    Logger.error('Error marking all notifications as read:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /ai/notifications/:id/read — Mark single notification as read
notificationRouter.patch('/:id/read', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Notifications']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  try {
    const userId = req?.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid notification ID format' });
    }

    const notification = await notificationRepository.findOne({
      where: { id, userId },
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    notification.isRead = true;
    await notificationRepository.save(notification);

    res.status(200).json({ message: 'Notification marked as read' });
  } catch (error) {
    Logger.error('Error marking notification as read:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /ai/notifications/:id — Delete a notification
notificationRouter.delete('/:id', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Notifications']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  try {
    const userId = req?.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid notification ID format' });
    }

    const notification = await notificationRepository.findOne({
      where: { id, userId },
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await notificationRepository.remove(notification);

    res.status(200).json({ message: 'Notification deleted' });
  } catch (error) {
    Logger.error('Error deleting notification:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
