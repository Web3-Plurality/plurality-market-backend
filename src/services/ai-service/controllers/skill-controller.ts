import express, { Request, Response } from 'express';
import { v4 as uuidv4, validate as isValidUUID } from 'uuid';
import { isAuthenticated, isAuthenticatedNativeOrMcp } from '../../user-service/middlewares/auth-middleware';
import { AppDataSource } from '../../../data-source';
import { UserAiProfile } from '../entity/user-ai-profile';
import { UserContext, ContextStatus } from '../entity/user-context';
import { resolveProfileAccess } from '../utils/permission';
import { recomputeAndStore as recomputeBucketHash } from '../utils/bucket-hash';
import { hashContent } from '../../blockchain-service/utils/hash-utils';
import { DEFAULT_SKILL } from '../utils/default-skill';
import Logger from '../../../lib/logger';

/**
 * Skill endpoints. Mounted under /ai/profile next to profileRouter, so the
 * routes below resolve as /ai/profile/:profileId/skill.
 *
 * A Skill = instructions (markdown playbook) + the bucket's memory. One
 * bucket holds at most one skill and the skill is optional: a bucket without
 * one is served the built-in DEFAULT_SKILL flagged `isDefault: true`.
 *
 * Visibility: name + summary are public elsewhere (lists, tokenURI). The
 * full instructions are only returned here, and only to callers that pass
 * resolveProfileAccess (creator of a draft, or NFT holder once minted).
 *
 * Freeze: once the bucket is minted (isImmutable = true) the skill can no
 * longer be edited or deleted, same rule as contexts.
 */
export const skillRouter = express.Router();
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);
const userContextRepository = AppDataSource.getRepository(UserContext);

const SKILL_NAME_MAX = 80;
const SKILL_SUMMARY_MAX = 280;
const SKILL_INSTRUCTIONS_MAX = 20_000;
const MEMORY_INDEX_MAX = 50;

// Canonical form of the instructions before hashing / storing, so the same
// text typed on Windows and macOS produces the same skillHash.
function normalizeInstructions(raw: string): string {
  return raw.replace(/\r\n/g, '\n').trim();
}

// Short listing of the bucket's completed contexts, so an agent reading the
// skill knows what memory it can search. Titles + descriptions only.
async function buildMemoryIndex(profileId: string) {
  const contexts = await userContextRepository.find({
    where: { profileId, status: ContextStatus.COMPLETED },
    order: { createdAt: 'ASC' },
    select: ['contextId', 'title', 'description', 'sourceType', 'createdAt'],
    take: MEMORY_INDEX_MAX,
  });
  return contexts.map((c) => ({
    contextId: c.contextId,
    title: c.title || 'Untitled',
    description: c.description || '',
    sourceType: c.sourceType || 'text',
  }));
}

// Shared response shape for GET and PUT.
async function serializeSkill(profile: UserAiProfile) {
  const hasSkill = !!profile.skillHash;
  const memoryIndex = await buildMemoryIndex(profile.id);
  return {
    profileId: profile.id,
    hasSkill,
    isDefault: !hasSkill,
    name: hasSkill ? profile.skillName : DEFAULT_SKILL.name,
    summary: hasSkill ? profile.skillSummary ?? '' : DEFAULT_SKILL.summary,
    instructions: hasSkill ? profile.skillInstructions : DEFAULT_SKILL.instructions,
    skillHash: hasSkill ? profile.skillHash : null,
    skillContextId: hasSkill ? profile.skillContextId : null,
    registeredOnChain: hasSkill ? profile.skillRegisteredOnChain : false,
    updatedAt: hasSkill && profile.skillUpdatedAt ? profile.skillUpdatedAt.toISOString() : null,
    isImmutable: profile.isImmutable,
    memoryIndex,
  };
}

const IMMUTABLE_ERROR = {
  error: 'bucket_immutable',
  message: 'This bucket is minted. Its skill is frozen on chain.',
};

// READ: the skill (or the default skill) for a bucket the caller can access.
skillRouter.get('/:profileId/skill', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    const { profileId } = req.params;

    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }
    if (!userId || !authAddress) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Creator OR NFT holder: that is the visibility rule for instructions.
    const access = await resolveProfileAccess(authAddress, userId, profileId);
    if (!access.hasAccess) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.status(200).json(await serializeSkill(profile));
  } catch (error) {
    Logger.error('Error fetching skill:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// UPSERT: create or replace the skill. Creator only, drafts only.
skillRouter.put('/:profileId/skill', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;
    const { name, summary, instructions } = (req.body ?? {}) as {
      name?: unknown;
      summary?: unknown;
      instructions?: unknown;
    };

    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
    if (!profile || profile.userId !== userId) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    if (profile.isImmutable) {
      return res.status(403).json(IMMUTABLE_ERROR);
    }

    // Validation. Plain messages, 400.
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Skill name is required' });
    }
    const cleanName = name.trim();
    if (cleanName.length > SKILL_NAME_MAX) {
      return res.status(400).json({ error: `Skill name is too long. Maximum length is ${SKILL_NAME_MAX} characters.` });
    }

    if (summary !== undefined && summary !== null && typeof summary !== 'string') {
      return res.status(400).json({ error: 'Skill summary must be a string' });
    }
    const cleanSummary = typeof summary === 'string' ? summary.trim() : '';
    if (cleanSummary.length > SKILL_SUMMARY_MAX) {
      return res
        .status(400)
        .json({ error: `Skill summary is too long. Maximum length is ${SKILL_SUMMARY_MAX} characters.` });
    }

    if (typeof instructions !== 'string') {
      return res.status(400).json({ error: 'Skill instructions are required' });
    }
    const cleanInstructions = normalizeInstructions(instructions);
    if (cleanInstructions.length === 0) {
      return res.status(400).json({ error: 'Skill instructions are required' });
    }
    if (cleanInstructions.length > SKILL_INSTRUCTIONS_MAX) {
      return res.status(400).json({
        error: `Skill instructions are too long. Maximum length is ${SKILL_INSTRUCTIONS_MAX} characters.`,
      });
    }

    // skillContextId is assigned once and never changes: it becomes the
    // on-chain id at registration, so re-saving must not rotate it.
    // Conditional UPDATE on isImmutable=false: a save(profile) here would
    // write the whole stale row back (un-freezing a bucket that a concurrent
    // prepare-registration just froze). Zero affected rows means the bucket
    // was minted between our read and this write.
    const updated = await userAiProfileRepository.update(
      { id: profileId, isImmutable: false },
      {
        skillName: cleanName,
        skillSummary: cleanSummary,
        skillInstructions: cleanInstructions,
        skillHash: hashContent(cleanInstructions),
        skillContextId: profile.skillContextId ?? uuidv4(),
        skillUpdatedAt: new Date(),
        skillRegisteredOnChain: false,
      },
    );
    if (!updated.affected) {
      return res.status(403).json(IMMUTABLE_ERROR);
    }

    // The skill hash is the first element of bucketHash, so any edit moves
    // the bucket's identity just like adding a context does.
    await recomputeBucketHash(profileId);

    const fresh = await userAiProfileRepository.findOne({ where: { id: profileId } });
    return res.status(200).json(await serializeSkill(fresh ?? profile));
  } catch (error) {
    Logger.error('Error saving skill:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE: remove the skill (bucket falls back to the default skill).
// Creator only, drafts only.
skillRouter.delete('/:profileId/skill', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Profile']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { profileId } = req.params;

    if (!isValidUUID(profileId)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
    if (!profile || profile.userId !== userId) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    if (profile.isImmutable) {
      return res.status(403).json(IMMUTABLE_ERROR);
    }

    // skillContextId is intentionally kept: if the creator adds a skill again
    // it reuses the same stable id. Everything else is cleared.
    // Conditional UPDATE on isImmutable=false for the same reason as in PUT.
    const updated = await userAiProfileRepository.update(
      { id: profileId, isImmutable: false },
      {
        skillName: null,
        skillSummary: null,
        skillInstructions: null,
        skillHash: null,
        skillRegisteredOnChain: false,
        skillUpdatedAt: null,
      },
    );
    if (!updated.affected) {
      return res.status(403).json(IMMUTABLE_ERROR);
    }

    await recomputeBucketHash(profileId);

    return res.status(204).send();
  } catch (error) {
    Logger.error('Error deleting skill:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
