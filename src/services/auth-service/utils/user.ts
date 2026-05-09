import crypto from 'crypto';
import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';
import { UserSession } from '../entity/user-session';
import { User } from '../../user-service/entity/user';

const userSessionRepository = AppDataSource.getRepository(UserSession);
const userRepository = AppDataSource.getRepository(User);

export const AddUserSession = async (userId: string, clientAppId?: string) => {
  try {
    // Create a new session
    const newUserSession = userSessionRepository.create({ userId, clientAppId });
    await userSessionRepository.save(newUserSession);
    Logger.info(`UserSession created: ${newUserSession.id}`);
    return newUserSession.id;
  } catch (error: any) {
    Logger.error(`Error in AddUserSession: ${error.message || JSON.stringify(error)}`);
    throw error;
  }
};

/**
 * Generate a random 256-bit encryption key (base64 encoded)
 */
export const generateChatEncKey = (): string => {
  return crypto.randomBytes(32).toString('base64');
};

/**
 * Ensure user has a chat encryption key. Generates and saves one if null.
 * Returns the key.
 */
export const ensureChatEncKey = async (userId: string): Promise<string> => {
  try {
    const user = await userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new Error('User not found');
    }

    if (user.chatEncKey) {
      return user.chatEncKey;
    }

    // Generate new key and save
    const newKey = generateChatEncKey();
    await userRepository.update(userId, { chatEncKey: newKey });
    Logger.info(`Generated chatEncKey for user ${userId}`);
    return newKey;
  } catch (error: any) {
    Logger.error(`Error in ensureChatEncKey: ${error.message || JSON.stringify(error)}`);
    throw error;
  }
};
