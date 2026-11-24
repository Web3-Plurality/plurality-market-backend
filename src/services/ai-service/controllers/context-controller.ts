import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { isAuthenticated, isAuthenticatedNativeOrMcp } from '../../user-service/middlewares/auth-middleware';
import axios from 'axios';
import { AppDataSource } from '../../../data-source';
import { UserContext, ContextStatus } from '../entity/user-context';
import { UserAiProfile } from '../entity/user-ai-profile';
import Logger from '../../../lib/logger';
import multer from 'multer';
import FormData from 'form-data';
import { createProfile } from './profile-controller';
import { sseManager } from '../utils/sse-manager';
import { v4 as uuidv4, validate as isValidUUID } from 'uuid';
import { resolveProfileAccess, canEditContext, hasMinRole } from '../utils/permission';
import { hashContent } from '../../blockchain-service/utils/hash-utils';
import { recomputeAndStore as recomputeBucketHash } from '../utils/bucket-hash';
import { failStaleContexts } from '../utils/stale-contexts';

dotenv.config();
export const contextRouter = express.Router();
const userContextRepository = AppDataSource.getRepository(UserContext);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);

// The AI service returns "untitled" (or nothing) when its LLM title pass
// fails — outage, quota, or a parse miss on the model's output. Rather than
// surface that literal to the user, fall back to the first meaningful line
// of the text itself.
function isUsableTitle(t: unknown): t is string {
  return typeof t === 'string' && t.trim().length > 0 && t.trim().toLowerCase() !== 'untitled';
}

function deriveTitleFromText(text: string): string {
  const firstLine = (text || '')
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[#>*\-\s]+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((l) => l.length > 0);
  if (!firstLine) return 'untitled';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

// Fire-and-forget wrapper: a hash recompute failure must never break the
// user-facing add/delete. The bucketHash is rebuildable from user_context
// at any time, so logging is sufficient. Immutability is enforced by the
// handlers' isImmutable checks — the throw inside recomputeAndStore is
// defense-in-depth.
function refreshBucketHash(profileId: string): void {
  recomputeBucketHash(profileId).catch((err) => {
    Logger.warn(`[bucket-hash] refresh failed for profile ${profileId}: ${err?.message || err}`);
  });
}

// Helper function to validate chatHistory structure
const validateChatHistory = (chatHistory: any): { valid: boolean; error?: string } => {
  if (!Array.isArray(chatHistory)) {
    return { valid: false, error: 'Chat history must be an array' };
  }

  // if (chatHistory.length > 100) {
  //   return { valid: false, error: 'Chat history is too long. Maximum 100 messages allowed.' };
  // }

  for (let i = 0; i < chatHistory.length; i++) {
    const message = chatHistory[i];

    if (typeof message !== 'object' || message === null) {
      return { valid: false, error: `Chat history message at index ${i} must be an object` };
    }

    if (!message.role || !['user', 'assistant'].includes(message.role)) {
      return { valid: false, error: `Chat history message at index ${i} must have role 'user' or 'assistant'` };
    }

    if (typeof message.content !== 'string') {
      return { valid: false, error: `Chat history message at index ${i} must have content as string` };
    }

    // if (message.content.length > 50000) {
    //   return { valid: false, error: `Chat history message at index ${i} is too long. Maximum 50,000 characters per message.` };
    // }
  }

  return { valid: true };
};

// this is for adding raw context to the profile
contextRouter.post('/add-raw-context', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Context']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  /* #swagger.requestBody = {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    profileId: { type: "string", description: "AI profile ID" },
                    context: { type: "string", description: "Raw text context to add" }
                  },
                  required: ["profileId", "context"]
                }
              }
            }
    } */
  /* #swagger.responses[200] = {
            description: 'Context added successfully',
            schema: {
              type: 'object',
              properties: {
                contextId: { type: 'string' },
                userId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                profileId: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' }
              }
            }
    } */
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    const { profileId, context, sourcePlatform, title: customTitle } = req.body;
    Logger.info(`[ADD_RAW_CONTEXT] user=${userId}, profile=${profileId || 'new'}`);

    // Validate context input
    if (!context) {
      return res.status(400).json({ error: 'Context is required' });
    }

    if (typeof context !== 'string') {
      return res.status(400).json({ error: 'Context must be a string' });
    }

    if (context.trim().length === 0) {
      return res.status(400).json({ error: 'Context cannot be empty' });
    }

    // if (context.length > 1000000) {
    //   return res.status(400).json({ error: 'Context is too long. Maximum length is 1,000,000 characters.' });
    // }

    let profile;
    let effectiveOwnerId = userId; // who owns the data namespace
    if (!profileId) {
      // create a new profile if no profile id is provided
      profile = await createProfile(userId || '', 'untitled', '');
      Logger.info('called create profile', profile?.id);
    } else {
      // Validate profileId is a valid UUID
      if (!isValidUUID(profileId)) {
        return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
      }

      // Permission check: must have editor+ access
      const access = await resolveProfileAccess(authAddress as string, userId as string, profileId as string);
      if (!access.hasAccess || !hasMinRole(access, 'editor')) {
        return res.status(404).json({ error: 'Profile not found or insufficient permissions' });
      }
      if (access.isImmutable) {
        return res.status(403).json({
          error: 'bucket_immutable',
          message: 'This bucket has been minted and is read-only. Add contexts to a different bucket.',
        });
      }

      effectiveOwnerId = access.ownerId || userId;

      profile = await userAiProfileRepository.findOne({
        where: { id: profileId },
      });
      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }
    }

    // Calculate content size in bytes from raw text
    const contentSize = context ? Buffer.byteLength(context, 'utf8') : 0;

    // Step 1: Create context with IN_PROGRESS status BEFORE calling AI service
    const contextId = uuidv4();
    const userContext = userContextRepository.create({
      userId: effectiveOwnerId, // store under owner's namespace
      contextId,
      title: 'untitled',
      description: '',
      profileId: profile?.id,
      status: ContextStatus.IN_PROGRESS,
      // Metadata for source identification
      sourceType: 'text',
      sourcePlatform: sourcePlatform || null,
      contentSize,
      contentHash: hashContent(context), // SHA-256 for on-chain provenance
    });
    await userContextRepository.save(userContext);
    refreshBucketHash(profile.id);

    // Step 2: Call the Python AI service endpoint
    const response = await axios.post(
      `${process.env.AI_SERVICE_URL}/rag/add-context`,
      {
        userId: effectiveOwnerId,
        profileId: profile?.id,
        context,
        contextId,
        // Forward the user's title so the AI service skips its LLM pass.
        title: customTitle || undefined,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
        },
      },
    );

    if (response.status !== 200) {
      Logger.error('Failed to add context to AI service');
      // Update status to ERROR on failure
      userContext.status = ContextStatus.ERROR;
      userContext.errorMessage = 'Failed to add context to AI service';
      await userContextRepository.save(userContext);
      return res.status(500).json({ error: 'Failed to add context to AI service' });
    }

    // Step 3: Update context with response data and COMPLETED status
    const extractedTitle = response?.data?.extractedTitle;
    userContext.title = customTitle || (isUsableTitle(extractedTitle) ? extractedTitle : deriveTitleFromText(context));
    userContext.description = response?.data?.extractedDescription || '';
    userContext.vectorIds = response?.data?.vectorIds || [];
    userContext.status = ContextStatus.COMPLETED;
    await userContextRepository.save(userContext);

    if (profile.profileName === 'untitled' || profile.profileName === '') {
      profile.profileName = userContext.title;
      await userAiProfileRepository.save(profile);
    }

    // Return the AI service response along with the saved context info
    res.status(200).json({
      contextId: userContext.contextId,
      userId: userContext.userId,
      title: userContext.title,
      description: userContext.description,
      profileId: userContext.profileId,
      createdAt: userContext.createdAt,
    });
  } catch (error) {
    Logger.error('Error in RAG controller:', error);
    res.status(500).send('Internal Server Error');
  }
});

// ── AICF bundle import ─────────────────────────────────────────────────────
// Accepts the JSON bundle exported by Memory Studio ("Export for
// Marketplace") and replays its items through the same async pipeline as
// /upload-file: one user_context row per item, content forwarded to the AI
// service as a .txt file, embedding + final status via the existing
// background queue + webhook — so the UI's normal context polling shows
// per-item progress with no new machinery. Items carry their own titles, so
// the LLM title pass is skipped: an import burns zero Gemini quota.
const IMPORT_BUNDLE_FORMAT = 'aicf-bucket-export';
const IMPORT_MAX_ITEMS = 100;
const IMPORT_MAX_ITEM_BYTES = 5 * 1024 * 1024;
// Matches the studio exporter's total cap, and keeps every legal bundle far
// below the 50mb JSON body-parser limit (index.ts) — otherwise a bundle
// could die at the parser with a non-JSON 413 instead of our error contract.
const IMPORT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

contextRouter.post('/import-bundle', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    const { profileId, bundle } = req.body as { profileId?: string; bundle?: any };

    if (!profileId || !isValidUUID(profileId)) {
      return res.status(400).json({ error: 'profileId (UUID) is required' });
    }
    // The bundle is UNTRUSTED input — anyone can handcraft one. Validate
    // shape and sizes strictly, never fetch any URL it may contain, and
    // treat its origin claims as self-attested (no provenance badge).
    if (!bundle || bundle.format !== IMPORT_BUNDLE_FORMAT || bundle.version !== 1) {
      return res.status(400).json({
        error: 'unrecognized_bundle',
        message: 'Not an AI Context Flow export bundle (format/version mismatch).',
      });
    }
    const items = bundle.contexts;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'empty_bundle', message: 'The bundle contains no contexts.' });
    }
    if (items.length > IMPORT_MAX_ITEMS) {
      return res.status(400).json({
        error: 'too_many_items',
        message: `A bundle may contain at most ${IMPORT_MAX_ITEMS} contexts. Split the export.`,
      });
    }

    // Permission check: must have editor+ access, bucket must not be minted.
    const access = await resolveProfileAccess(authAddress as string, userId as string, profileId);
    if (!access.hasAccess || !hasMinRole(access, 'editor')) {
      return res.status(404).json({ error: 'Profile not found or insufficient permissions' });
    }
    if (access.isImmutable) {
      return res.status(403).json({
        error: 'bucket_immutable',
        message: 'This bucket has been minted and is read-only. Import into a different bucket.',
      });
    }
    const effectiveOwnerId = access.ownerId || userId;
    const profile = await userAiProfileRepository.findOne({ where: { id: profileId } });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    type ImportItemResult = { index: number; contextId?: string; title?: string; status: string; error?: string };
    const results: ImportItemResult[] = [];

    // Sequential on purpose: each forward returns quickly (embedding runs in
    // the AI service's background queue), and a serial loop keeps one import
    // from monopolizing the service's request workers.
    let importedBytes = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? {};
      const content = typeof item.content === 'string' ? item.content : '';
      const title = (
        typeof item.title === 'string' && item.title.trim() ? item.title.trim() : `Imported item ${i + 1}`
      ).slice(0, 200);
      if (!content.trim()) {
        results.push({ index: i, title, status: 'skipped', error: 'empty content' });
        continue;
      }
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > IMPORT_MAX_ITEM_BYTES) {
        results.push({
          index: i,
          title,
          status: 'skipped',
          error: `content exceeds ${IMPORT_MAX_ITEM_BYTES / (1024 * 1024)}MB`,
        });
        continue;
      }
      if (importedBytes + contentBytes > IMPORT_MAX_TOTAL_BYTES) {
        results.push({
          index: i,
          title,
          status: 'skipped',
          error: `bundle content exceeds ${IMPORT_MAX_TOTAL_BYTES / (1024 * 1024)}MB total`,
        });
        continue;
      }

      // Re-check the freeze flag EVERY item: this loop spans many seconds,
      // and a concurrent prepare-registration can freeze the bucket and pin
      // its bucketHash mid-import. Rows added after that moment would sit
      // OUTSIDE the on-chain commitment — permanently divergent content and
      // a mint that can never pass the confirm gate.
      const freshProfile = await userAiProfileRepository.findOne({
        where: { id: profileId },
        select: ['id', 'isImmutable'],
      });
      if (!freshProfile || freshProfile.isImmutable) {
        results.push({
          index: i,
          title,
          status: 'skipped',
          error: 'bucket was frozen for minting during the import',
        });
        continue;
      }
      importedBytes += contentBytes;

      const sourceType = ['text', 'chat', 'file'].includes(item.sourceType) ? item.sourceType : 'text';
      const contextId = uuidv4();
      const userContext = userContextRepository.create({
        userId: effectiveOwnerId, // store under owner's namespace
        contextId,
        title,
        description: typeof item.description === 'string' ? item.description.slice(0, 2000) : '',
        profileId,
        status: ContextStatus.IN_PROGRESS,
        // Metadata for source identification — sourcePlatform keeps the
        // platform the memory was originally captured from (self-attested).
        sourceType,
        sourcePlatform: typeof item.sourcePlatform === 'string' ? item.sourcePlatform.slice(0, 60) : 'aicf-import',
        contentSize: contentBytes,
        contentHash: hashContent(content), // SHA-256 for on-chain provenance
      });
      await userContextRepository.save(userContext);

      try {
        const formData = new FormData();
        formData.append('file', Buffer.from(content, 'utf8'), {
          filename: `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'imported'}.txt`,
          contentType: 'text/plain',
        });
        formData.append('userId', effectiveOwnerId);
        formData.append('profileId', profileId);
        formData.append('contextId', contextId);
        // Skips the AI service's LLM title pass — the item is pre-titled.
        formData.append('title', title);

        const response = await axios.post(`${process.env.AI_SERVICE_URL}/rag/upload-file`, formData, {
          headers: {
            ...formData.getHeaders(),
            'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });
        if (response.status !== 200) {
          throw new Error(`AI service returned ${response.status}`);
        }
        results.push({ index: i, contextId, title, status: 'processing' });
      } catch (err) {
        userContext.status = ContextStatus.ERROR;
        userContext.errorMessage = 'Failed to hand the imported item to the AI service';
        await userContextRepository.save(userContext);
        results.push({ index: i, contextId, title, status: 'error', error: (err as Error).message });
      }
    }

    refreshBucketHash(profileId);

    const accepted = results.filter((r) => r.status === 'processing').length;
    return res.status(200).json({
      profileId,
      total: items.length,
      accepted,
      items: results,
    });
  } catch (error) {
    Logger.error('Error importing bundle:', error);
    return res.status(500).json({ error: 'Failed to import bundle' });
  }
});

// this is for adding chat context to the profile, specifically for extension
contextRouter.post(
  '/add-chat-context',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Context']
    /* #swagger.security = [{
            "bearerAuth": []
    }] */
    /* #swagger.requestBody = {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    profileId: { type: "string", description: "AI profile ID (optional - creates new profile if not provided)" },
                    chatHistory: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          role: { type: "string", enum: ["user", "assistant"] },
                          content: { type: "string" }
                        }
                      },
                      description: "Array of chat messages"
                    }
                  },
                  required: ["chatHistory"]
                }
              }
            }
    } */
    /* #swagger.responses[200] = {
            description: 'Chat context added successfully',
            schema: {
              type: 'object',
              properties: {
                contextId: { type: 'string' },
                userId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                profileId: { type: 'string' },
                createdAt: { type: 'string', format: 'date-time' }
              }
            }
    } */
    try {
      const userId = req?.user?.id;
      const authAddress = req?.user?.authAddress;
      const { profileId, chatHistory, platform, title: customTitle } = req.body;
      Logger.info(
        `[ADD_CHAT_CONTEXT] user=${userId}, profile=${profileId || 'new'}, messages=${chatHistory?.length || 0}`,
      );

      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      // Validate chatHistory
      if (!chatHistory) {
        return res.status(400).json({ error: 'Chat history is required' });
      }

      const chatHistoryValidation = validateChatHistory(chatHistory);
      if (!chatHistoryValidation.valid) {
        return res.status(400).json({ error: chatHistoryValidation.error });
      }

      // Calculate content size in bytes from chat history
      const chatContent = chatHistory?.map((m: { content: string }) => m.content).join('\n') || '';
      const contentSize = Buffer.byteLength(chatContent, 'utf8');

      let profile;
      let effectiveOwnerId = userId; // who owns the data namespace
      if (!profileId) {
        // create a new profile if no profile id is provided
        profile = await createProfile(userId, 'untitled', '');
        Logger.info('called create profile', profile?.id);
      } else {
        // Validate profileId is a valid UUID
        if (!isValidUUID(profileId)) {
          return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
        }

        // Permission check: must have editor+ access
        const access = await resolveProfileAccess(authAddress as string, userId as string, profileId as string);
        if (!access.hasAccess || !hasMinRole(access, 'editor')) {
          return res.status(404).json({ error: 'Profile not found or insufficient permissions' });
        }
        // Minted buckets are frozen: their bucketHash is on-chain, so adding
        // a chat context would silently diverge content from provenance. The
        // other add routes already carry this gate; this one was the gap.
        if (access.isImmutable) {
          return res.status(403).json({
            error: 'bucket_immutable',
            message: 'This bucket has been minted and is read-only. Save the conversation to a different bucket.',
          });
        }

        effectiveOwnerId = access.ownerId || userId;

        profile = await userAiProfileRepository.findOne({
          where: { id: profileId },
        });
        if (!profile) {
          return res.status(404).json({ error: 'Profile not found' });
        }
      }

      // Step 1: Create context with IN_PROGRESS status BEFORE calling AI service
      const contextId = uuidv4();
      const userContext = userContextRepository.create({
        userId: effectiveOwnerId, // store under owner's namespace
        contextId,
        title: 'untitled',
        description: '',
        profileId: profile?.id,
        status: ContextStatus.IN_PROGRESS,
        // Metadata for source identification
        sourceType: 'chat',
        sourcePlatform: platform || 'unknown',
        contentSize,
        contentHash: hashContent(JSON.stringify(chatHistory)), // SHA-256 for on-chain provenance
      });
      await userContextRepository.save(userContext);
      refreshBucketHash(profile.id);

      // Step 2: Call the Python AI service endpoint
      const response = await axios.post(
        `${process.env.AI_SERVICE_URL}/rag/add-rag-context`,
        {
          userId: effectiveOwnerId,
          profileId: profile?.id,
          chatHistory,
          contextId,
          // The AI service runs no LLM pass; it titles the transcript with
          // this, or with the first user message when absent.
          title: customTitle || undefined,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
          },
        },
      );

      if (response.status !== 200) {
        Logger.error('Failed to add context to AI service');
        // Update status to ERROR on failure
        userContext.status = ContextStatus.ERROR;
        userContext.errorMessage = 'Failed to add context to AI service';
        await userContextRepository.save(userContext);
        return res.status(500).json({ error: 'Failed to add context to AI service' });
      }

      // Step 3: Update context with response data and COMPLETED status
      userContext.title = customTitle || response?.data?.extractedTitle || 'untitled';
      userContext.description = response?.data?.extractedDescription || '';
      userContext.vectorIds = response?.data?.vectorIds || [];
      userContext.status = ContextStatus.COMPLETED;
      await userContextRepository.save(userContext);

      if (profile.profileName === 'untitled' || profile.profileName === '') {
        profile.profileName = customTitle || response?.data?.extractedTitle || 'untitled';
        await userAiProfileRepository.save(profile);
      }

      // Return the AI service response along with the saved context info
      res.status(200).json({
        contextId: userContext.contextId,
        userId: userContext.userId,
        title: userContext.title,
        description: userContext.description,
        profileId: userContext.profileId,
        createdAt: userContext.createdAt,
      });
    } catch (error) {
      Logger.error('Error in RAG controller:', error);
      res.status(500).send('Internal Server Error');
    }
  },
);

contextRouter.get('/', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Context']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    const { profileId } = req.query;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Validate profileId if provided
    if (profileId && !isValidUUID(profileId as string)) {
      return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
    }

    if (profileId) {
      // Permission check: must have viewer+ access to the bucket
      const access = await resolveProfileAccess(authAddress as string, userId as string, profileId as string);
      if (!access.hasAccess) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      await failStaleContexts({ profileId: profileId as string });

      const contexts = await userContextRepository.find({
        where: { profileId: profileId as string },
        order: { createdAt: 'ASC' },
      });

      return res.status(200).json({ contexts });
    }

    // No profileId — return only the user's own contexts
    await failStaleContexts({ userId });
    const contexts = await userContextRepository.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });

    res.status(200).json({ contexts });
  } catch (error) {
    Logger.error('Error fetching user contexts:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * SSE endpoint for real-time context processing updates
 * GET /ai/context/events
 * IMPORTANT: This route must come BEFORE /:contextId to avoid matching "events" as a contextId
 */
contextRouter.get('/events', isAuthenticated, (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Context']
  /* #swagger.security = [{
        "bearerAuth": []
  }] */
  /* #swagger.responses[200] = {
        description: 'SSE connection established - sends real-time context updates',
        content: {
          'text/event-stream': {
            schema: {
              type: 'string',
              example: 'event: context-update\ndata: {"contextId":"uuid","status":"completed"}\n\n'
            }
          }
        }
  } */
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    if (!userId) {
      Logger.warn('SSE connection attempt without userId');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const clientId = uuidv4();

    // Add client to SSE manager
    sseManager.addClient(userId, clientId, res);

    // Note: Connection will remain open until client disconnects
    // The response is handled by the SSE manager
  } catch (error) {
    Logger.error('Error in SSE endpoint:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /ai/context/:contextId/content — read context content with pagination
// Proxies to AI service's GET /rag/get-context-data (used by MCP read_context tool)
contextRouter.get(
  '/:contextId/content',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Context']
    /* #swagger.security = [{ "bearerAuth": [] }] */
    try {
      const userId = req?.user?.id;
      const authAddress = req?.user?.authAddress;
      const { contextId } = req.params;
      const { startChunk = '0', limit = '0' } = req.query;

      if (!isValidUUID(contextId)) {
        return res.status(400).json({ error: 'Invalid Context ID format. Expected a valid UUID.' });
      }

      // Find context and check permission on parent bucket
      const context = await userContextRepository.findOne({
        where: { contextId },
      });
      if (!context) {
        return res.status(404).json({ error: 'Context not found' });
      }

      const access = await resolveProfileAccess(authAddress as string, userId as string, context.profileId);
      if (!access.hasAccess) {
        return res.status(404).json({ error: 'Context not found' });
      }

      const effectiveUserId = access.ownerId || userId;

      // Convert limit=0 to a large number (AI service slicing [0:0] returns empty)
      const parsedLimit = parseInt(limit as string, 10) || 0;
      const aiServiceLimit = parsedLimit === 0 ? 10000 : parsedLimit;

      const aiResponse = await axios.get(`${process.env.AI_SERVICE_URL}/rag/get-context-data`, {
        params: {
          userId: effectiveUserId,
          contextId,
          startChunk: parseInt(startChunk as string, 10) || 0,
          limit: aiServiceLimit,
        },
        headers: {
          'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
        },
      });

      const data = aiResponse.data;

      // Enrich with DB metadata
      return res.json({
        contextId: data.contextId,
        title: data.title,
        description: context.description || '',
        contentType: data.contentType,
        sourceType: context.sourceType || '',
        sourcePlatform: context.sourcePlatform || '',
        originalFileName: context.originalFileName || '',
        totalChunks: data.totalChunks,
        content: data.content,
        nextChunk: data.nextChunk ?? null,
      });
    } catch (error: any) {
      if (error?.response?.status === 404) {
        return res.status(404).json({ error: 'No content found for this context' });
      }
      Logger.error('Error fetching context content:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },
);

contextRouter.delete('/:contextId', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Context']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    const { contextId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Validate contextId
    if (!contextId) {
      return res.status(400).json({ error: 'Context ID is required' });
    }

    // Validate contextId is a valid UUID
    if (!isValidUUID(contextId)) {
      return res.status(400).json({ error: 'Invalid Context ID format. Expected a valid UUID.' });
    }

    // Find the context
    const userContext = await userContextRepository.findOne({
      where: { contextId },
    });

    if (!userContext) {
      return res.status(404).json({ error: 'Context not found or you do not have permission to delete it' });
    }

    // Permission check: must have edit access to this context
    const access = await resolveProfileAccess(authAddress as string, userId as string, userContext.profileId);
    if (!access.hasAccess || !canEditContext(access, userContext, userId)) {
      return res.status(403).json({ error: 'You do not have permission to delete this context' });
    }
    if (access.isImmutable) {
      return res.status(403).json({
        error: 'bucket_immutable',
        message: 'This bucket has been minted and is read-only. Contexts cannot be deleted.',
      });
    }

    const effectiveUserId = access.ownerId || userId;

    // call AI service to delete from vector store as well
    try {
      await axios.delete(
        `${process.env.AI_SERVICE_URL}/rag/delete-context?userId=${effectiveUserId}&contextId=${contextId}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
          },
        },
      );
    } catch (aiServiceError) {
      Logger.warn('Failed to delete context from AI service, but database deletion succeeded:', aiServiceError);
    }

    // Capture info before deletion
    const deletedTitle = userContext.title;
    const deletedProfileId = userContext.profileId;

    // Delete the context from database
    await userContextRepository.remove(userContext);
    refreshBucketHash(deletedProfileId);

    res.status(200).json({
      message: 'Context deleted successfully',
      contextId: contextId,
    });
  } catch (error) {
    Logger.error('Error deleting user context:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Defense-in-depth for non-ASCII upload filenames. Multer 2.1.x changed busboy's
// default param-charset from utf8 to latin1, so non-ASCII filenames (Japanese,
// Thai, Arabic, emoji…) arrive mojibake'd. We pin multer to ~2.0.2 to avoid
// this, but keep this conditional repair as a safety net so a future bump
// can't silently re-introduce the regression. No-op for filenames that are
// already correct (the early returns guarantee we never double-decode).
const fixMojibakeFilename = (name: string): string => {
  if (!name) return name;
  // Pure ASCII — nothing to do
  if (!/[\x80-\xFF]/.test(name)) return name;
  // Contains real Unicode code points (> 0xFF) — already correctly decoded
  if (![...name].every((c) => c.charCodeAt(0) <= 0xff)) return name;
  // Reinterpret the latin1 byte sequence as UTF-8
  const reinterpreted = Buffer.from(name, 'latin1').toString('utf8');
  // Bytes weren't valid UTF-8 → original was genuinely latin1, leave alone
  if (reinterpreted.includes('�')) return name;
  return reinterpreted;
};

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    // Repair mojibake'd filename in place so every downstream read of
    // req.file.originalname (logger, controller, AI-service forward) sees
    // the correct UTF-8 string.
    file.originalname = fixMojibakeFilename(file.originalname);

    // Check file type
    const allowedTypes = [
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
      'application/msword', // doc
      'text/markdown',
      'text/x-markdown',
      'application/json',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
      'application/vnd.ms-powerpoint', // ppt
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
      'application/vnd.ms-excel', // xls
      'text/csv',
      'text/html',
      'application/rtf',
      'application/vnd.oasis.opendocument.text', // odt
      'application/epub+zip', // epub
    ];
    const allowedExtensions = [
      '.txt',
      '.docx',
      '.doc',
      '.md',
      '.json',
      '.pdf',
      '.pptx',
      '.ppt',
      '.xlsx',
      '.xls',
      '.csv',
      '.html',
      '.rtf',
      '.odt',
      '.epub',
    ];

    const fileExtension = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Supported formats: TXT, DOC, DOCX, PDF, PPT, PPTX, XLS, XLSX, CSV, HTML, RTF, ODT, EPUB, Markdown, JSON',
        ),
      );
    }
  },
});

// Custom middleware to handle multipart requests properly
const handleMultipart = (req: Request, res: Response, next: any) => {
  const contentType = req.get('Content-Type') || '';

  Logger.info(`Request details: ${req.method} ${req.url} (${contentType})`);

  if (contentType.includes('multipart/form-data')) {
    // For multipart requests, use multer directly
    upload.single('file')(req, res, (err) => {
      if (err) {
        Logger.error('Multer error:', err);
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File size exceeds 10MB limit' });
          }
          return res.status(400).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  } else {
    // For non-multipart requests, proceed normally
    next();
  }
};

contextRouter.post(
  '/upload-file',
  isAuthenticated,
  handleMultipart,
  async (req: Request & { file?: Express.Multer.File }, res: Response) => {
    // #swagger.tags = ['AI-Context']
    /* #swagger.security = [{
            "bearerAuth": []
    }] */
    /* #swagger.requestBody = {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                      description: "The file to upload (TXT, DOCX, Markdown, JSON, or PDF, max 10MB)"
                    },
                    profileId: {
                      type: "string",
                      description: "AI profile ID to associate the context with"
                    }
                  },
                  required: ["file", "profileId"]
                }
              }
            }
    } */
    /* #swagger.responses[200] = {
            description: 'File uploaded successfully - processing starts in background',
            schema: {
              type: 'object',
              properties: {
                contextId: { type: 'string' },
                userId: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                profileId: { type: 'string' },
                fileName: { type: 'string' },
                fileSize: { type: 'number' },
                status: { type: 'string', enum: ['IN_PROGRESS', 'COMPLETED', 'ERROR'] },
                createdAt: { type: 'string', format: 'date-time' }
              }
            }
    } */
    /* #swagger.responses[400] = {
            description: 'Bad request - File required, invalid file type, or file size exceeds limit'
    } */
    /* #swagger.responses[404] = {
            description: 'Profile not found'
    } */
    /* #swagger.responses[500] = {
            description: 'Internal server error'
    } */
    let userContext: any = null;
    try {
      const userId = req?.user?.id;
      const authAddress = req?.user?.authAddress;
      const { profileId } = req.body;

      Logger.info(
        `[UPLOAD_FILE] user=${userId}, file=${req.file?.originalname || 'no file'} (${
          req.file?.size || 0
        } bytes), profile=${profileId}`,
      );

      // Validate file upload - supports TXT, DOCX, Markdown, JSON, and PDF files
      if (!req.file) {
        Logger.error('No file received in upload request');
        return res.status(400).json({ error: 'File is required' });
      }

      // Validate required fields
      if (!profileId) {
        return res.status(400).json({ error: 'Profile ID is required' });
      }

      // Validate profileId is a valid UUID
      if (!isValidUUID(profileId)) {
        return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
      }

      // Permission check: must have editor+ access
      const access = await resolveProfileAccess(authAddress as string, userId as string, profileId as string);
      if (!access.hasAccess || !hasMinRole(access, 'editor')) {
        return res.status(404).json({ error: 'Profile not found or insufficient permissions' });
      }
      if (access.isImmutable) {
        return res.status(403).json({
          error: 'bucket_immutable',
          message: 'This bucket has been minted and is read-only. Add contexts to a different bucket.',
        });
      }

      const effectiveOwnerId = access.ownerId || userId;

      const profile = await userAiProfileRepository.findOne({
        where: { id: profileId },
      });

      if (!profile) {
        return res.status(404).json({ error: 'Profile not found' });
      }

      // Step 1: Create context with IN_PROGRESS status BEFORE calling AI service
      const contextId = uuidv4();
      userContext = userContextRepository.create({
        userId: effectiveOwnerId,
        contextId,
        title: req.file.originalname,
        description: '',
        profileId,
        status: ContextStatus.IN_PROGRESS,
        // Metadata for source identification
        originalFileName: req.file.originalname,
        sourceType: 'file',
        contentSize: req.file.size,
        contentHash: hashContent(req.file.buffer), // SHA-256 for on-chain provenance
      });
      await userContextRepository.save(userContext);
      refreshBucketHash(profileId);

      // Create form data for the AI service
      const formData = new FormData();
      formData.append('file', req.file.buffer, {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });
      formData.append('userId', effectiveOwnerId);
      formData.append('profileId', profileId);
      formData.append('contextId', contextId);

      // Step 2: Call the Python AI service endpoint
      const response = await axios.post(`${process.env.AI_SERVICE_URL}/rag/upload-file`, formData, {
        headers: {
          ...formData.getHeaders(),
          'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      if (response.status !== 200) {
        Logger.error('Failed to upload file to AI service');
        // Update status to ERROR on failure
        userContext.status = ContextStatus.ERROR;
        userContext.errorMessage = 'Failed to upload file to AI service';
        await userContextRepository.save(userContext);
        return res.status(500).json({ error: 'Failed to upload file to AI service' });
      }

      // Step 3: Update context with response data (title/description from AI service)
      userContext.title = response?.data?.extractedTitle || req.file.originalname;
      userContext.description = response?.data?.extractedDescription || '';
      await userContextRepository.save(userContext);

      // Return the AI service response along with the saved context info
      res.status(200).json({
        contextId: contextId,
        userId: userId,
        title: userContext.title,
        description: userContext.description,
        profileId: profileId,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        status: ContextStatus.IN_PROGRESS,
        createdAt: userContext.createdAt,
      });
    } catch (error: any) {
      Logger.error('Error in file upload controller:', error);

      // Handle multer errors
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File size exceeds 10MB limit' });
        }
        return res.status(400).json({ error: error.message });
      }

      // Handle axios errors from AI service
      if (error.response) {
        const aiServiceError = error.response.data?.detail || error.response.data?.error || 'AI service error';
        // Update context with error status
        if (userContext) {
          userContext.status = ContextStatus.ERROR;
          userContext.errorMessage = aiServiceError;
          await userContextRepository.save(userContext);

          // Return context info so frontend can add it to the list
          return res.status(error.response.status || 500).json({
            error: aiServiceError,
            context: {
              contextId: userContext.contextId,
              title: userContext.title,
              description: userContext.description,
              status: userContext.status,
              errorMessage: userContext.errorMessage,
              sourceType: userContext.sourceType,
              sourcePlatform: userContext.sourcePlatform,
              originalFileName: userContext.originalFileName,
              contentSize: userContext.contentSize,
              createdAt: userContext.createdAt,
            },
          });
        }
        return res.status(error.response.status || 500).json({ error: aiServiceError });
      }

      res.status(500).json({ error: 'Internal Server Error' });
    }
  },
);

/**
 * Webhook endpoint for AI service to report context processing completion
 * POST /ai/context/webhook
 */
contextRouter.post('/webhook', async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Context']
  /* #swagger.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                apiKey: {
                  type: "string",
                  description: "AI service API key for authentication"
                },
                contextId: {
                  type: "string",
                  description: "Context ID that was processed"
                },
                userId: {
                  type: "string",
                  description: "User ID who owns the context"
                },
                status: {
                  type: "string",
                  enum: ["completed", "inprogress", "error"],
                  description: "Processing status"
                },
                errorMessage: {
                  type: "string",
                  description: "Error message if status is error"
                },
                vectorIds: {
                  type: "array",
                  items: { type: "string" },
                  description: "Array of vector IDs stored in vector database"
                },
                processingProgress: {
                  type: "number",
                  description: "Processing progress percentage (0-100)"
                }
              },
              required: ["apiKey", "contextId", "userId", "status"]
            }
          }
        }
  } */
  /* #swagger.responses[200] = {
        description: 'Webhook received successfully'
  } */
  /* #swagger.responses[401] = {
        description: 'Unauthorized - Invalid API key'
  } */
  /* #swagger.responses[404] = {
        description: 'Context not found'
  } */
  try {
    // Extract API key from X-API-Key header
    const apiKey = req.headers['x-api-key'] as string;
    const { contextId, userId, status, errorMessage, vectorIds, processingProgress } = req.body;

    // Validate API key
    if (!apiKey || apiKey !== process.env.BACKEND_API_KEY) {
      Logger.warn(`Webhook received with invalid/missing API key for contextId=${contextId}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Find the context in database
    const userContext = await userContextRepository.findOne({
      where: { contextId, userId },
    });

    if (!userContext) {
      Logger.warn(`Webhook context not found: contextId=${contextId}, userId=${userId}`);
      return res.status(404).json({ error: 'Context not found' });
    }

    // Update context status
    if (status === 'completed') {
      userContext.status = ContextStatus.COMPLETED;
    } else if (status === 'inprogress') {
      userContext.status = ContextStatus.IN_PROGRESS;
    } else if (status === 'error') {
      userContext.status = ContextStatus.ERROR;
    }

    if (errorMessage) {
      userContext.errorMessage = errorMessage;
    }
    if (vectorIds) {
      userContext.vectorIds = vectorIds;
    }

    await userContextRepository.save(userContext);

    // Send SSE update to all connected clients for this user
    sseManager.sendContextUpdate(userId, {
      contextId,
      status: userContext.status,
      errorMessage: userContext.errorMessage,
      vectorIds: userContext.vectorIds,
      processingProgress: processingProgress ?? undefined,
      // Include title/description so frontend can update without refetching
      title: userContext.title,
      description: userContext.description,
    });

    Logger.info(`Webhook processed: contextId=${contextId}, status=${status}, progress=${processingProgress}%`);

    res.status(200).json({
      message: 'Webhook processed successfully',
      contextId,
      status: userContext.status,
      processingProgress,
    });
  } catch (error) {
    Logger.error('Error in webhook endpoint:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
