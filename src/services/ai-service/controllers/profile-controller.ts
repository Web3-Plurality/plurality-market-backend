import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { isAuthenticated, isAuthenticatedNativeOrMcp } from '../../user-service/middlewares/auth-middleware';
import axios from 'axios';
import { AppDataSource } from '../../../data-source';
import { UserContext } from '../entity/user-context';
import { UserAiProfile } from '../entity/user-ai-profile';
import Logger from '../../../lib/logger';
import { v2 as cloudinary } from 'cloudinary';
import { userProfileOperations, smartProfileOperations } from '../../../lib/metrics';
import { validate as isValidUUID } from 'uuid';
import { resolveProfileAccess } from '../utils/permission';
import { walletToBucketHashes } from '../../blockchain-service/utils/wallet-nfts';
import { logActivity } from '../utils/activity';
import { notifyShareMembers } from '../utils/notify';

dotenv.config();
export const profileRouter = express.Router();
const userContextRepository = AppDataSource.getRepository(UserContext);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);

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
profileRouter.post('/', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
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
    const err = error as {
      message?: string;
      code?: string;
      response?: { status?: number; data?: unknown };
      config?: { url?: string };
    };
    Logger.error('Error creating AI profile:', {
      message: err.message,
      code: err.code,
      url: err.config?.url,
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      stack: (error as Error)?.stack,
    });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
// READ: list profiles the caller can access.
//
// Default (Studio's view): drafts only — `WHERE userId = ? AND isImmutable = false`.
// Once a bucket is minted, it leaves Studio and lives in My Minted NFTs.
//
// `?includeMinted=true` (MCP / agent view): drafts + every minted bucket the
// caller's wallet currently holds the NFT for. Lets the agent search across
// memory you minted (and still own) or memory you bought on the marketplace,
// without exposing buckets you sold.
profileRouter.get('/', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    const includeMinted = String(req.query.includeMinted || '').toLowerCase() === 'true';

    // Drafts owned by caller (the Studio view).
    const drafts = await userAiProfileRepository.find({
      where: { userId, isImmutable: false },
      order: { createdAt: 'DESC' },
    });

    // Optional second slice: minted buckets the wallet currently holds an
    // NFT for. Pulled in only when the caller explicitly asks (MCP agent),
    // so Studio stays clean.
    let mintedHeld: UserAiProfile[] = [];
    if (includeMinted && authAddress) {
      const held = await walletToBucketHashes(authAddress);
      if (held.size > 0) {
        mintedHeld = await userAiProfileRepository
          .createQueryBuilder('p')
          .where('p.isImmutable = true')
          .andWhere('p.mintedTokenId IS NOT NULL')
          .andWhere('LOWER(p.bucketHash) IN (:...hashes)', { hashes: Array.from(held) })
          .orderBy('p.mintedAt', 'DESC')
          .getMany();
      }
    }

    const combined = [...drafts, ...mintedHeld];
    const ownedWithCounts = await Promise.all(
      combined.map(async (profile) => {
        const contextCount = await userContextRepository.count({ where: { profileId: profile.id } });
        return {
          ...profile,
          contextCount,
          isOwner: true,
          role: 'owner' as const,
          sharedBy: null,
        };
      }),
    );

    res.status(200).json({ profiles: ownedWithCounts });
  } catch (error) {
    Logger.error('Error fetching AI profiles:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// READ: Get specific AI profile by ID (owner or shared)
profileRouter.get('/:profileId', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    const { profileId } = req.params;

    if (!userId || !authAddress) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Validate profileId is a valid UUID
    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    const access = await resolveProfileAccess(authAddress, userId, profileId);
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
    if (profile.isImmutable) {
      return res.status(403).json({
        error: 'bucket_immutable',
        message: 'Cannot rename a minted bucket — its presentation is frozen on chain.',
      });
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
    if (profile.isImmutable) {
      // Deleting a minted bucket would orphan the on-chain NFT (holder would
      // lose access permanently with no recovery). Hard-block.
      return res.status(403).json({
        error: 'bucket_immutable',
        message: 'Cannot delete a minted bucket — the on-chain NFT still references its contents.',
      });
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
      // Delete associated contexts
      await transactionalEntityManager.delete(UserContext, { userId, profileId: profile.id });

      // Delete the profile. With the NFT-as-access-token model, the snapshot
      // table is gone — no orphan cleanup needed here.
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

    if (!profile) {
      return res.status(404).json({ error: 'AI profile not found or you do not own it' });
    }

    profile.isPinned = isPinned ? true : null;
    const updatedProfile = await userAiProfileRepository.save(profile);
    return res.status(200).json({
      message: `Profile ${isPinned ? 'pinned' : 'unpinned'} successfully`,
      profile: updatedProfile,
    });
  } catch (error) {
    Logger.error('Error updating profile pin status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
