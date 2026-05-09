import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { isAuthenticated, isAuthenticatedNativeOrMcp } from '../../user-service/middlewares/auth-middleware';
import { chargeMcpCall } from '../../subscription-service/middlewares/charge-mcp-middleware';
import axios from 'axios';
import { AppDataSource } from '../../../data-source';
import { UserContext } from '../entity/user-context';
import { UserAiProfile } from '../entity/user-ai-profile';
import { ProfileAccess } from '../entity/profile-access';
import { User } from '../../user-service/entity/user';
import Logger from '../../../lib/logger';
import { v2 as cloudinary } from 'cloudinary';
import { userProfileOperations, smartProfileOperations } from '../../../lib/metrics';
import { validate as isValidUUID } from 'uuid';
import { resolveProfileAccess } from '../utils/permission';
import { logActivity } from '../utils/activity';
import { notifyShareMembers } from '../utils/notify';

dotenv.config();
export const profileRouter = express.Router();
const userContextRepository = AppDataSource.getRepository(UserContext);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);
const profileAccessRepository = AppDataSource.getRepository(ProfileAccess);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET, // Click 'View Credentials' below to copy your API secret
});

export async function createProfile(userId: string, profileName: string, image: string) {
  // Validate and sanitize profileName
  if (profileName && typeof profileName !== 'string') {
    throw new Error('Profile name must be a string');
  }

  if (profileName && profileName.length > 200) {
    throw new Error('Profile name is too long. Maximum length is 200 characters.');
  }

  // Sanitize profileName by trimming whitespace
  const sanitizedProfileName = profileName ? profileName.trim() : 'untitled';

  // Validate image if provided
  if (image && typeof image !== 'string') {
    throw new Error('Image must be a string (base64 or URL)');
  }

  if (image && image.length > 10000000) {
    throw new Error('Image data is too large. Maximum size is 10MB.');
  }

  let imageUrl = '';

  // Upload an image
  if (image) {
    const uploadResult = await cloudinary.uploader.upload(image).catch((error) => {
      console.log(error);
    });
    imageUrl = uploadResult?.secure_url || '';
  }
  // Create new AI profile
  const aiProfile = userAiProfileRepository.create({
    userId,
    profileName: sanitizedProfileName,
    image: imageUrl || '',
  });

  const savedProfile = await userAiProfileRepository.save(aiProfile);

  // Track profile creation
  smartProfileOperations.inc({ operation: 'create', status: 'success' });

  userProfileOperations.inc({ user_id: userId, operation: 'create' });

  return savedProfile;
}

// CREATE: Add new AI profile
profileRouter.post(
  '/',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  chargeMcpCall(1),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Profile']
    /* #swagger.security = [{
            "bearerAuth": []
    }] */
    try {
      const userId = req?.user?.id;
      const { profileName, image } = req.body;

      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Validate profileName
      if (profileName && typeof profileName !== 'string') {
        return res.status(400).json({ error: 'Profile name must be a string' });
      }

      if (profileName && profileName.length > 200) {
        return res.status(400).json({ error: 'Profile name is too long. Maximum length is 200 characters.' });
      }

      // Validate image
      if (image && typeof image !== 'string') {
        return res.status(400).json({ error: 'Image must be a string (base64 or URL)' });
      }

      if (image && image.length > 10000000) {
        return res.status(400).json({ error: 'Image data is too large. Maximum size is 10MB.' });
      }

      const savedProfile = await createProfile(userId, profileName, image);

      res.status(201).json(savedProfile);
    } catch (error) {
      Logger.error('Error creating AI profile:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },
);
// READ: Get all AI profiles for user (owned + shared)
profileRouter.get(
  '/',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  chargeMcpCall(1),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Profile']
    /* #swagger.security = [{
            "bearerAuth": []
    }] */
    try {
      const userId = req?.user?.id;

      // Fetch owned profiles
      const ownedProfiles = await userAiProfileRepository.find({
        where: { userId },
        order: { createdAt: 'DESC' },
      });

      // Fetch context counts for owned profiles
      const ownedWithCounts = await Promise.all(
        ownedProfiles.map(async (profile) => {
          const contextCount = await userContextRepository.count({
            where: { userId, profileId: profile.id },
          });

          return {
            ...profile,
            contextCount,
            isOwner: true,
            role: 'owner' as const,
            sharedBy: null,
          };
        }),
      );

      // Fetch shared profiles
      const sharedBuckets = await profileAccessRepository
        .createQueryBuilder('bs')
        .innerJoin(UserAiProfile, 'p', 'p.id = bs.profileId')
        .leftJoin(User, 'u', 'u.id = bs.ownerId')
        .select([
          'p.id AS id',
          'p.userId AS "userId"',
          'p.profileName AS "profileName"',
          'p.image AS image',
          'p.suggestedPrompts AS "suggestedPrompts"',
          'p.published AS published',
          'bs.isPinned AS "isPinned"',
          'p.createdAt AS "createdAt"',
          'bs.role AS role',
          'bs.ownerId AS "ownerId"',
          'u.email AS "ownerEmail"',
          'u.name AS "ownerName"',
          'u.authAddress AS "ownerWallet"',
        ])
        .where('bs.grantedToId = :userId', { userId })
        .orderBy('bs.createdAt', 'DESC')
        .getRawMany();

      const sharedWithCounts = await Promise.all(
        sharedBuckets.map(async (b) => {
          const contextCount = await userContextRepository.count({
            where: { profileId: b.id },
          });

          return {
            id: b.id,
            userId: b.userId,
            profileName: b.profileName,
            image: b.image,
            suggestedPrompts: b.suggestedPrompts,
            published: b.published,
            isPinned: b.isPinned,
            createdAt: b.createdAt,
            contextCount,
            isOwner: false,
            role: b.role,
            sharedBy: {
              id: b.ownerId,
              email: b.ownerEmail || null,
              name: b.ownerName || null,
              wallet: b.ownerWallet || null,
            },
          };
        }),
      );

      res.status(200).json({ profiles: [...ownedWithCounts, ...sharedWithCounts] });
    } catch (error) {
      Logger.error('Error fetching AI profiles:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },
);

// READ: Get specific AI profile by ID (owner or shared)
profileRouter.get('/:profileId', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Validate profileId is a valid UUID
    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    const access = await resolveProfileAccess(userId, profileId);
    if (!access.hasAccess) {
      return res.status(404).json({ error: 'AI profile not found' });
    }

    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'AI profile not found' });
    }

    res.status(200).json({
      ...profile,
      isOwner: access.isOwner,
      role: access.effectiveRole,
    });
  } catch (error) {
    Logger.error('Error fetching AI profile:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// UPDATE: Update AI profile
profileRouter.put('/:profileId', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;
    const { profileName, image } = req.body;

    // Validate profileId is a valid UUID
    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    // Find the profile to ensure it belongs to the authenticated user
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId, userId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'AI profile not found or you do not have permission to update it' });
    }

    // Validate profileName
    if (profileName && typeof profileName !== 'string') {
      return res.status(400).json({ error: 'Profile name must be a string' });
    }

    if (profileName && profileName.length > 200) {
      return res.status(400).json({ error: 'Profile name is too long. Maximum length is 200 characters.' });
    }

    if (profileName && profileName.trim().length === 0) {
      return res.status(400).json({ error: 'Profile name cannot be empty' });
    }

    // Validate image
    if (image && typeof image !== 'string') {
      return res.status(400).json({ error: 'Image must be a string (base64 or URL)' });
    }

    if (image && image.length > 10000000) {
      return res.status(400).json({ error: 'Image data is too large. Maximum size is 10MB.' });
    }

    // Sanitize profileName
    const sanitizedProfileName = profileName ? profileName.trim() : null;

    // Check if new profile name conflicts with existing profiles (excluding current one)
    if (sanitizedProfileName && sanitizedProfileName !== profile.profileName) {
      const existingProfile = await userAiProfileRepository.findOne({
        where: { userId, profileName: sanitizedProfileName },
      });

      if (existingProfile) {
        return res.status(409).json({ error: 'Profile name already exists for this user' });
      }
    }

    // Capture old name for activity log
    const oldName = profile.profileName;

    // Update profile fields
    if (sanitizedProfileName) profile.profileName = sanitizedProfileName;
    if (image !== undefined) profile.image = image;

    const updatedProfile = await userAiProfileRepository.save(profile);

    // Fire-and-forget: log rename activity + notify
    if (sanitizedProfileName && sanitizedProfileName !== oldName) {
      logActivity(profileId, userId as string, 'bucket_renamed', {
        metadata: { oldName, newName: sanitizedProfileName },
      });
      notifyShareMembers(
        profileId,
        userId as string,
        'bucket_renamed',
        `Profile renamed from '${oldName}' to '${sanitizedProfileName}'`,
        undefined,
        {
          profileId,
          oldName,
          newName: sanitizedProfileName,
        },
      );
    }

    res.status(200).json(updatedProfile);
  } catch (error) {
    Logger.error('Error updating AI profile:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE: Delete AI profile
profileRouter.delete('/:profileId', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;

    // Validate profileId is a valid UUID
    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    // Find the profile to ensure it belongs to the authenticated user
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId, userId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'AI profile not found or you do not have permission to delete it' });
    }

    // call AI service to delete from vector store as well
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
      Logger.info('Deleted all contexts from AI service');
    } catch (aiServiceError) {
      Logger.warn('Failed to delete all contexts from AI service, but database deletion succeeded:', aiServiceError);
    }

    // Use transaction to ensure all cascading deletes are atomic
    await AppDataSource.transaction(async (transactionalEntityManager) => {
      // Delete associated shares
      await transactionalEntityManager.delete(ProfileAccess, { profileId: profile.id });

      // Delete associated contexts
      await transactionalEntityManager.delete(UserContext, { userId, profileId: profile.id });

      // Delete the profile
      await transactionalEntityManager.remove(UserAiProfile, profile);
    });

    res.status(200).json({
      message: 'AI profile deleted successfully',
      profileId: profileId,
    });
  } catch (error) {
    Logger.error('Error deleting AI profile:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PUBLISH/UNPUBLISH: Toggle profile visibility
profileRouter.patch('/:profileId/publish', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;
    const { published } = req.body;

    // Validate profileId is a valid UUID
    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    // Validate required fields
    if (typeof published !== 'boolean') {
      return res.status(400).json({ error: 'Published status is required and must be a boolean' });
    }

    // Find the profile to ensure it belongs to the authenticated user
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId, userId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'AI profile not found or you do not have permission to modify it' });
    }

    // Update the published status
    profile.published = published;
    const updatedProfile = await userAiProfileRepository.save(profile);

    res.status(200).json({
      message: `Profile ${published ? 'published' : 'unpublished'} successfully`,
      profile: updatedProfile,
    });
  } catch (error) {
    Logger.error('Error updating profile publish status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PIN/UNPIN: Toggle profile pin status
profileRouter.patch('/:profileId/pin', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;
    const { isPinned } = req.body;

    // Validate profileId is a valid UUID
    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    // Validate required fields
    if (typeof isPinned !== 'boolean') {
      return res.status(400).json({ error: 'isPinned status is required and must be a boolean' });
    }

    // Check if user owns this profile
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId, userId },
    });

    if (profile) {
      // Owner: pin state lives on the profile
      profile.isPinned = isPinned ? true : null;
      const updatedProfile = await userAiProfileRepository.save(profile);
      return res.status(200).json({
        message: `Profile ${isPinned ? 'pinned' : 'unpinned'} successfully`,
        profile: updatedProfile,
      });
    }

    // Not owner — check if shared with user
    const access = await AppDataSource.getRepository(ProfileAccess).findOne({
      where: { profileId, grantedToId: userId },
    });

    if (!access) {
      return res.status(404).json({ error: 'AI profile not found or you do not have permission to modify it' });
    }

    // Shared bucket: pin state lives on the access record
    access.isPinned = isPinned ? true : null;
    await AppDataSource.getRepository(ProfileAccess).save(access);

    res.status(200).json({
      message: `Profile ${isPinned ? 'pinned' : 'unpinned'} successfully`,
    });
  } catch (error) {
    Logger.error('Error updating profile pin status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
