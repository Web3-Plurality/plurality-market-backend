import express, { Request, Response } from 'express';
import { AppDataSource } from '../../../data-source';
import { ProfileAccess, AccessRole } from '../entity/profile-access';
import { UserAiProfile } from '../entity/user-ai-profile';
import { User } from '../../user-service/entity/user';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import Logger from '../../../lib/logger';
import { validate as isValidUUID } from 'uuid';
import { logActivity } from '../utils/activity';
import { notifyShareMembers } from '../utils/notify';

export const profileAccessRouter = express.Router();

const profileAccessRepository = AppDataSource.getRepository(ProfileAccess);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);
const userRepository = AppDataSource.getRepository(User);

// POST /ai/profile/:profileId/access — Grant access to users (batch)
profileAccessRouter.post('/:profileId/access', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Access']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  /* #swagger.description = 'Grant access to a memory profile for one or more users. Supports batch invites. Returns 207 on partial success.' */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            shares: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  identifier: { type: "string", description: "Email or wallet address" },
                  identifierType: { type: "string", enum: ["email", "wallet"] },
                  role: { type: "string", enum: ["viewer", "editor"] }
                },
                required: ["identifier", "identifierType", "role"]
              }
            }
          },
          required: ["shares"]
        }
      }
    }
  } */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;
    const { shares } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid profile ID format' });
    }

    if (!Array.isArray(shares) || shares.length === 0) {
      return res.status(400).json({ error: 'shares array is required and must not be empty' });
    }

    // Verify the user owns this profile
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId, userId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found or you do not own it' });
    }

    const successful: any[] = [];
    const failed: any[] = [];

    for (const share of shares) {
      const { identifier, identifierType, role } = share;

      // Validate identifierType
      if (!['email', 'wallet'].includes(identifierType)) {
        failed.push({ identifier, error: 'identifierType must be "email" or "wallet"' });
        continue;
      }

      // Validate role
      if (!['viewer', 'editor'].includes(role)) {
        failed.push({ identifier, error: 'role must be "viewer" or "editor"' });
        continue;
      }

      // Look up the target user, or create a stub if not found.
      // Use case-insensitive equality to match how SIWE login resolves wallet users
      // (`LOWER(u.authAddress) = :addr`). Without this, any legacy/mixed-case row in
      // `users` is invisible here — we'd spawn a ghost stub with a lowercase address,
      // grant access to the stub's UUID, and then when the real user logs in SIWE
      // resolves to the ORIGINAL UUID and the share lookup misses. Same logic for
      // emails: if a user was created with a mixed-case email (Google OAuth etc),
      // the old exact-match lookup would create a duplicate stub.
      let targetUser: User | null = null;
      const normalizedIdentifier = identifier.trim().toLowerCase();
      if (identifierType === 'email') {
        targetUser = await userRepository
          .createQueryBuilder('u')
          .where('LOWER(u.email) = :email', { email: normalizedIdentifier })
          .getOne();
      } else {
        targetUser = await userRepository
          .createQueryBuilder('u')
          .where('LOWER(u.authAddress) = :addr', { addr: normalizedIdentifier })
          .getOne();
      }

      if (!targetUser) {
        // Create a stub user so they get access immediately; auth flows will pick up this record on first login
        const stubData: Partial<User> =
          identifierType === 'email' ? { email: normalizedIdentifier } : { authAddress: normalizedIdentifier };
        targetUser = await userRepository.save(userRepository.create(stubData));
        Logger.info(`[ACCESS] Created stub user ${targetUser.id} for ${identifierType}: ${normalizedIdentifier}`);
      }

      // Prevent self-sharing
      if (targetUser.id === userId) {
        failed.push({ identifier, error: 'Cannot share with yourself' });
        continue;
      }

      // Check for existing share
      const existingShare = await profileAccessRepository.findOne({
        where: { profileId: profileId, grantedToId: targetUser.id },
      });

      if (existingShare) {
        if (existingShare.role === role) {
          // Same role — treat as success with a hint
          successful.push({ id: existingShare.id, identifier, role, alreadyShared: true });
        } else {
          // Different role — update it
          const oldRole = existingShare.role;
          existingShare.role = role as AccessRole;
          await profileAccessRepository.save(existingShare);
          successful.push({ id: existingShare.id, identifier, role, roleUpdated: true, previousRole: oldRole });

          logActivity(profileId, userId, 'share_role_changed', {
            targetType: 'share',
            targetId: existingShare.id,
            metadata: { from: oldRole, to: role },
          });
          notifyShareMembers(
            profileId,
            userId,
            'share_role_changed',
            `Your role was changed from ${oldRole} to ${role} in '${profile.profileName}'`,
            undefined,
            {
              profileId,
              from: oldRole,
              to: role,
            },
          );
        }
        continue;
      }

      // Create the access entry
      const accessEntry = profileAccessRepository.create({
        profileId: profileId,
        ownerId: userId,
        grantedToId: targetUser.id,
        role: role as AccessRole,
        createdBy: userId,
      });

      await profileAccessRepository.save(accessEntry);
      successful.push({ id: accessEntry.id, identifier, role });

      // Fire-and-forget: log activity + notify the granted user
      logActivity(profileId, userId, 'share_granted', {
        targetType: 'share',
        targetId: accessEntry.id,
        metadata: {
          grantedToEmail: identifierType === 'email' ? identifier : undefined,
          grantedToWallet: identifierType === 'wallet' ? identifier : undefined,
          role,
        },
      });
      notifyShareMembers(
        profileId,
        userId,
        'bucket_shared',
        `You were given ${role} access to '${profile.profileName}'`,
        undefined,
        {
          profileId,
          profileName: profile.profileName,
          role,
        },
      );
    }

    const statusCode = failed.length > 0 && successful.length > 0 ? 207 : failed.length > 0 ? 400 : 201;

    res.status(statusCode).json({
      successful,
      failed,
      summary: { total: shares.length, successful: successful.length, failed: failed.length },
    });
  } catch (error) {
    Logger.error('Error granting profile access:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /ai/profile/:profileId/access — List all access entries for a profile (owner only)
profileAccessRouter.get('/:profileId/access', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Access']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  /* #swagger.description = 'List all users who have access to a profile. Only the profile owner can view this.' */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid profile ID format' });
    }

    // Verify the user owns this profile
    const profile = await userAiProfileRepository.findOne({
      where: { id: profileId, userId },
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found or you do not own it' });
    }

    // Fetch access entries with user details
    const entries = await profileAccessRepository
      .createQueryBuilder('bs')
      .leftJoin(User, 'u', 'u.id = bs.grantedToId')
      .select([
        'bs.id AS id',
        'bs.role AS role',
        'bs.createdAt AS "createdAt"',
        'u.email AS email',
        'u.authAddress AS "authAddress"',
        'u.name AS name',
      ])
      .where('bs.profileId = :profileId', { profileId })
      .getRawMany();

    const shares = entries.map((s) => ({
      id: s.id,
      role: s.role,
      createdAt: s.createdAt,
      user: {
        email: s.email || null,
        name: s.name || null,
        wallet: s.authAddress || null,
      },
    }));

    res.status(200).json({ shares });
  } catch (error) {
    Logger.error('Error listing profile access:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /ai/profile/:profileId/access/:accessId — Update access role
profileAccessRouter.patch('/:profileId/access/:accessId', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Access']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  /* #swagger.description = 'Update the role of an existing access entry. Only the profile owner can change roles.' */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["viewer", "editor"] }
          },
          required: ["role"]
        }
      }
    }
  } */
  try {
    const userId = req?.user?.id;
    const { profileId, accessId } = req.params;
    const { role } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!isValidUUID(accessId)) {
      return res.status(400).json({ error: 'Invalid access ID format' });
    }

    if (!['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'role must be "viewer" or "editor"' });
    }

    // Find the access entry and verify ownership
    const accessEntry = await profileAccessRepository.findOne({
      where: { id: accessId, profileId: profileId, ownerId: userId },
    });

    if (!accessEntry) {
      return res.status(404).json({ error: 'Access entry not found or you do not own the profile' });
    }

    const oldRole = accessEntry.role;
    accessEntry.role = role as AccessRole;
    await profileAccessRepository.save(accessEntry);

    logActivity(profileId, userId, 'share_role_changed', {
      targetType: 'share',
      targetId: accessEntry.id,
      metadata: { from: oldRole, to: role },
    });
    notifyShareMembers(
      profileId,
      userId,
      'share_role_changed',
      `Your role was changed from ${oldRole} to ${role}`,
      undefined,
      {
        profileId,
        from: oldRole,
        to: role,
      },
    );

    res.status(200).json({ message: 'Access role updated', access: { id: accessEntry.id, role: accessEntry.role } });
  } catch (error) {
    Logger.error('Error updating access:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /ai/profile/:profileId/access/:accessId — Revoke access
profileAccessRouter.delete('/:profileId/access/:accessId', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Access']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  /* #swagger.description = 'Revoke access, removing the user from the profile. Only the profile owner can revoke.' */
  try {
    const userId = req?.user?.id;
    const { profileId, accessId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!isValidUUID(accessId)) {
      return res.status(400).json({ error: 'Invalid access ID format' });
    }

    // Find the access entry and verify ownership
    const accessEntry = await profileAccessRepository.findOne({
      where: { id: accessId, profileId: profileId, ownerId: userId },
    });

    if (!accessEntry) {
      return res.status(404).json({ error: 'Access entry not found or you do not own the profile' });
    }

    const revokedUserId = accessEntry.grantedToId;
    await profileAccessRepository.remove(accessEntry);

    logActivity(profileId, userId, 'share_revoked', {
      targetType: 'share',
      targetId: accessId,
      metadata: { revokedUserId },
    });
    notifyShareMembers(profileId, userId, 'share_revoked', 'Your access was revoked', undefined, {
      profileId,
    });

    res.status(200).json({ message: 'Access revoked successfully' });
  } catch (error) {
    Logger.error('Error revoking access:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
