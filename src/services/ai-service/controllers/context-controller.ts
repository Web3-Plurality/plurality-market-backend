import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { isAuthenticated, isAuthenticatedNativeOrMcp } from '../../user-service/middlewares/auth-middleware';
import { chargeMcpCall } from '../../subscription-service/middlewares/charge-mcp-middleware';
import axios from 'axios';
import { AppDataSource } from '../../../data-source';
import { UserContext, ContextStatus } from '../entity/user-context';
import { UserAiProfile } from '../entity/user-ai-profile';
import { IpCredit } from '../entity/ip-credit';
import Logger from '../../../lib/logger';
import multer from 'multer';
import FormData from 'form-data';
import { createProfile } from './profile-controller';
import { userRagRequests, userQueryRequests } from '../../../lib/metrics';
import { sseManager } from '../utils/sse-manager';
import { v4 as uuidv4, validate as isValidUUID } from 'uuid';
import { User } from '../../user-service/entity/user';
import { resolveProfileAccess, canEditContext, hasMinRole } from '../utils/permission';
import { logActivity } from '../utils/activity';
import { notifyShareMembers } from '../utils/notify';
import {
  checkContextSizeLimitMiddleware,
  checkSubscriptionAndCreditLimit,
  checkModelAccess,
} from '../../subscription-service/middlewares/subscription-middleware';
import { deductCredits, estimateBytesFromCharCount } from '../../subscription-service/utils';
import { getModelConfig } from '../../subscription-service/model-tiers';

dotenv.config();
export const contextRouter = express.Router();
const userContextRepository = AppDataSource.getRepository(UserContext);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);
const ipCreditRepository = AppDataSource.getRepository(IpCredit);

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

// Helper function to get client IP address
const getClientIP = (req: Request): string => {
  // Use Express's built-in IP detection (requires trust proxy setting)
  if (req.ip) {
    return req.ip.replace(/^::ffff:/, ''); // Remove IPv6 prefix if present
  }

  // Fallback to ips array if available
  if (req.ips && req.ips.length > 0) {
    return req.ips[0].replace(/^::ffff:/, '');
  }

  // Final fallback to connection remote address
  const remoteAddress = req.connection?.remoteAddress || req.socket?.remoteAddress;
  if (remoteAddress) {
    return remoteAddress.replace(/^::ffff:/, '');
  }

  return '';
};

// Helper function to manage IP credits
const getOrCreateIpCredit = async (ipAddress: string): Promise<IpCredit> => {
  let ipCredit = await ipCreditRepository.findOne({ where: { ipAddress } });

  if (!ipCredit) {
    ipCredit = ipCreditRepository.create({
      ipAddress,
      credits: 100, // Default credits for new IP
      tokensUsed: 0,
    });
    await ipCreditRepository.save(ipCredit);
  }

  return ipCredit;
};

// this is for adding raw context to the profile
contextRouter.post(
  '/add-raw-context',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  checkSubscriptionAndCreditLimit,
  checkContextSizeLimitMiddleware,
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
      const { profileId, context, sourcePlatform, sourceUrl, title: customTitle } = req.body;
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
        const access = await resolveProfileAccess(userId as string, profileId as string);
        if (!access.hasAccess || !hasMinRole(access, 'editor')) {
          return res.status(404).json({ error: 'Profile not found or insufficient permissions' });
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
        sourceUrl: sourceUrl || null,
        contentSize,
        addedBy: userId, // track who actually added it
      });
      await userContextRepository.save(userContext);

      // Step 2: Call the Python AI service endpoint
      const response = await axios.post(
        `${process.env.AI_SERVICE_URL}/rag/add-context`,
        {
          userId: effectiveOwnerId,
          profileId: profile?.id,
          context,
          contextId,
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

      // Fire-and-forget: activity log + notifications
      logActivity(profile.id, userId as string, 'context_added', {
        targetType: 'context',
        targetId: contextId,
        metadata: { title: userContext.title, sourceType: 'text' },
      });
      notifyShareMembers(
        profile.id,
        userId as string,
        'context_added',
        `A new context '${userContext.title}' was added to '${profile.profileName}'`,
        undefined,
        {
          profileId: profile.id,
          contextId,
          profileName: profile.profileName,
        },
      );

      // Deduct credits
      if (response?.data?.tokens_used?.total_tokens) {
        const result = await deductCredits(
          userId as string,
          response.data?.tokens_used?.total_tokens || 1,
          response.data?.tokens_used?.model,
        );
        if (!result.success) Logger.error('[ADD_RAW_CONTEXT] Failed to deduct credits for user:', userId);
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

// this is for adding chat context to the profile, specifically for extension
contextRouter.post(
  '/add-chat-context',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  checkSubscriptionAndCreditLimit,
  checkContextSizeLimitMiddleware,
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
      const { profileId, chatHistory, platform, sourceUrl, title: customTitle } = req.body;
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
        const access = await resolveProfileAccess(userId as string, profileId as string);
        if (!access.hasAccess || !hasMinRole(access, 'editor')) {
          return res.status(404).json({ error: 'Profile not found or insufficient permissions' });
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
        sourceUrl: sourceUrl || null,
        contentSize,
        addedBy: userId, // track who actually added it
      });
      await userContextRepository.save(userContext);

      // Step 2: Call the Python AI service endpoint
      const response = await axios.post(
        `${process.env.AI_SERVICE_URL}/rag/add-rag-context`,
        {
          userId: effectiveOwnerId,
          profileId: profile?.id,
          chatHistory,
          contextId,
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

      // Fire-and-forget: activity log + notifications
      logActivity(profile.id, userId, 'context_added', {
        targetType: 'context',
        targetId: contextId,
        metadata: { title: userContext.title, sourceType: 'chat' },
      });
      notifyShareMembers(
        profile.id,
        userId,
        'context_added',
        `A new context '${userContext.title}' was added to '${profile.profileName}'`,
        undefined,
        {
          profileId: profile.id,
          contextId,
          profileName: profile.profileName,
        },
      );

      // Deduct credits
      if (response?.data?.tokens_used?.total_tokens) {
        const result = await deductCredits(
          userId as string,
          response.data?.tokens_used?.total_tokens || 1,
          response.data?.tokens_used?.model,
        );
        if (!result.success) Logger.error('[ADD_CHAT_CONTEXT] Failed to deduct credits for user:', userId);
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

// Query contexts
// TODO: Public access feature - currently disabled (see rejection in unauthenticated block below)
contextRouter.post(
  '/query',
  isAuthenticated,
  checkSubscriptionAndCreditLimit,
  checkModelAccess,
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Context']
    /* #swagger.security = [{
            "bearerAuth": []
    }] */
    /* #swagger.parameters['body'] = {
            in: 'body',
            description: 'Query parameters',
            required: true,
            schema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: "User's query or question",
                  example: 'What is the capital of France?'
                },
                profileId: {
                  type: 'string',
                  description: 'AI profile ID to query against (optional - empty string for no profile)',
                  example: '123e4567-e89b-12d3-a456-426614174000'
                },
                model: {
                  type: 'string',
                  description: 'LLM model to use. Defaults to gemini-2.5-flash',
                  default: 'gemini-2.5-flash',
                  example: 'gemini-2.5-flash',
                  enum: ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'claude-sonnet-4', 'claude-sonnet-3.7', 'claude-sonnet-3.5', 'claude-haiku-4.5', 'llama-3.3-70b', 'llama-3.2-3b', 'llama-3.2-1b', 'llama-3.1-70b', 'llama-3.1-8b', 'mistral-large', 'mistral-large-3', 'mistral-small', 'pixtral-large', 'nova-pro', 'nova-lite', 'nova-micro', 'gpt-oss-120b', 'deepseek-r1-distill-llama', 'writer-palmyra-x4', 'writer-palmyra-fin']
                },
                k: {
                  type: 'number',
                  description: 'Number of context chunks to retrieve',
                  default: 5,
                  example: 5
                },
                chatHistory: {
                  type: 'array',
                  description: 'Previous chat messages for context',
                  default: [],
                  items: {
                    type: 'object',
                    properties: {
                      role: {
                        type: 'string',
                        enum: ['user', 'assistant'],
                        example: 'user'
                      },
                      content: {
                        type: 'string',
                        example: 'Hello'
                      }
                    }
                  }
                },
                enableWebSearch: {
                  type: 'boolean',
                  description: 'Enable web search to augment answers',
                  example: false
                },
                enableUrlExtraction: {
                  type: 'boolean',
                  description: 'Enable URL extraction from query',
                  example: false
                }
              },
              required: ['query']
            }
    } */
    /* #swagger.responses[200] = {
            description: 'Query executed successfully',
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string', description: 'AI-generated answer' },
                sources: {
                  type: 'array',
                  items: { type: 'object' },
                  description: 'Source contexts used for the answer'
                },
                tokens_used: {
                  type: 'object',
                  properties: {
                    input_tokens: { type: 'number' },
                    output_tokens: { type: 'number' },
                    total_tokens: { type: 'number' }
                  }
                },
                credits: {
                  type: 'object',
                  properties: {
                    remaining: { type: 'number' },
                    used: { type: 'number' },
                    totalTokensUsed: { type: 'number' }
                  },
                  description: 'Credit info (only for unauthenticated users)'
                }
              }
            }
    } */
    /* #swagger.responses[400] = {
            description: 'Bad request - Missing required fields (query or profileId)'
    } */
    /* #swagger.responses[403] = {
            description: 'Forbidden - Profile not accessible or not published (when profileId provided)'
    } */
    /* #swagger.responses[404] = {
            description: 'Profile not found (when profileId provided)'
    } */
    /* #swagger.responses[429] = {
            description: 'Insufficient credits (unauthenticated users only)'
    } */
    try {
      const userId = req?.user?.id;
      const {
        query,
        profileId,
        k = 5,
        chatHistory = [],
        enableWebSearch,
        enableUrlExtraction,
        model = 'gemini-2.5-flash',
      } = req.body;
      const isAuthenticated = !!userId;
      // TODO: Uncomment when enabling public access
      // let ipCredit: IpCredit | null = null;

      // Validate required fields
      if (!query) {
        return res.status(400).json({ error: 'Query is required' });
      }

      // Validate query is a string and not too long
      if (typeof query !== 'string') {
        return res.status(400).json({ error: 'Query must be a string' });
      }

      if (query.trim().length === 0) {
        return res.status(400).json({ error: 'Query cannot be empty' });
      }

      // if (query.length > 10000) {
      //   return res.status(400).json({ error: 'Query is too long. Maximum length is 10000 characters.' });
      // }

      // Normalize empty string to null for profileId
      const normalizedProfileId = profileId === '' ? null : profileId;

      if (normalizedProfileId) {
        // Validate profileId is a valid UUID only if provided
        if (!isValidUUID(normalizedProfileId)) {
          return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
        }
      }

      // Validate k parameter
      if (typeof k !== 'number' || k < 1 || k > 100 || !Number.isInteger(k)) {
        return res.status(400).json({ error: 'Parameter k must be an integer between 1 and 100' });
      }

      // Silent fallback for unknown/deprecated/premium-denied models (backwards compat with older clients)
      const FALLBACK_MODEL = 'gemini-2.5-flash';
      const FALLBACK_MODEL_LABEL = 'Gemini 2.5 Flash';
      let effectiveModel = model;
      let originalModel: string | null = null;
      let fallbackReason: 'unknown' | 'premium' | 'unsupported' | null = null;
      // Case 1: middleware already flagged a fallback (premium or unsupported)
      const middlewareFallbackFrom = (req as any).modelFallbackFrom as string | undefined;
      const middlewareFallbackReason = (req as any).modelFallbackReason as string | undefined;
      if (middlewareFallbackFrom) {
        originalModel = middlewareFallbackFrom;
        effectiveModel = FALLBACK_MODEL;
        fallbackReason = middlewareFallbackReason === 'unsupported' ? 'unsupported' : 'premium';
      } else if (model && !getModelConfig(model)) {
        // Case 2: unknown model key from older clients
        originalModel = model;
        effectiveModel = FALLBACK_MODEL;
        fallbackReason = 'unknown';
        Logger.warn(`Unknown model '${originalModel}' requested, falling back to ${FALLBACK_MODEL}`);
      }

      // Validate chatHistory
      const chatHistoryValidation = validateChatHistory(chatHistory);
      if (!chatHistoryValidation.valid) {
        return res.status(400).json({ error: chatHistoryValidation.error });
      }

      // TODO: Public access disabled - uncomment IP credit logic below to re-enable
      if (!isAuthenticated) {
        return res.status(401).json({ error: 'Authentication required' });

        // IP rate limiting for unauthenticated users (disabled)
        // const clientIP = getClientIP(req);
        // console.log('clientIP', clientIP);
        // if (!clientIP) {
        //   return res.status(400).json({ error: 'Unable to identify client IP' });
        // }

        // ipCredit = await getOrCreateIpCredit(clientIP);

        // // Check if IP has sufficient credits
        // if (ipCredit.credits <= 0) {
        //   return res.status(429).json({
        //     error: 'Insufficient credits',
        //     credits: ipCredit.credits,
        //     tokensUsed: ipCredit.tokensUsed,
        //   });
        // }
      }

      let contextSummaries: string[] = [];
      let effectiveUserId = userId || 'anonymous';

      // Only process profile and contexts if profileId is provided
      if (normalizedProfileId) {
        // Permission check: must have viewer+ access
        const access = await resolveProfileAccess(userId as string, normalizedProfileId);
        if (!access.hasAccess) {
          return res.status(404).json({ error: 'Profile not found' });
        }

        effectiveUserId = access.ownerId || userId || 'anonymous';

        // Get context summaries for this profile
        const contexts = await userContextRepository.find({
          where: { profileId: normalizedProfileId },
          order: { createdAt: 'ASC' },
        });

        contextSummaries = contexts.map((context) => JSON.stringify(context.description));
        Logger.info(`contextSummaries: ${contextSummaries.length} summaries loaded`);
      } else {
        // No profile mode - just use empty context summaries
        Logger.info('No profile provided, running query without context');
      }

      // Call the Python AI service endpoint for querying contexts
      const requestPayload = {
        query,
        userId: effectiveUserId,
        profileId: normalizedProfileId || '',
        k,
        chatHistory,
        contextSummary: contextSummaries,
        enableWebSearch,
        enableUrlExtraction,
        model: effectiveModel, // Selected LLM model (gemini or bedrock model key)
        requestingUserId: userId, // Actual user for permission checks (may differ from effectiveUserId on shared buckets)
      };

      // Track per-user query request

      userQueryRequests.inc({ user_id: userId || 'anonymous', endpoint_type: 'agentic-query' });

      Logger.info(
        `[AI_QUERY] user=${userId}, model=${effectiveModel}, profile=${normalizedProfileId || 'none'}, chatHistory=${
          chatHistory.length
        }`,
      );
      const response = await axios.post(`${process.env.AI_SERVICE_URL}/rag/agentic-query`, requestPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
        },
      });

      if (response.status !== 200) {
        Logger.error('Failed to query contexts from AI service');
        return res.status(500).json({ error: 'Failed to query contexts from AI service' });
      }

      // TODO: Public access disabled - credit deduction for unauthenticated users
      // if (!isAuthenticated && ipCredit) {
      //   const tokensUsed = response.data?.tokens_used?.total_tokens || 1; // eslint-disable-line
      //   const creditCost = Math.ceil(tokensUsed / 100); // 1 credit per 100 tokens (adjust as needed)

      //   ipCredit.credits = Math.max(0, ipCredit.credits - creditCost);
      //   ipCredit.tokensUsed += tokensUsed;
      //   await ipCreditRepository.save(ipCredit);

      //   // Add credit information to response
      //   response.data.credits = {
      //     remaining: ipCredit.credits,
      //     used: creditCost,
      //     totalTokensUsed: ipCredit.tokensUsed,
      //   };
      // }

      // Deduct credits per model — reasoning (Gemini) and response (selected model) at their own rates
      // Reasoning tokens are charged at discounted rate (1 credit per 300 tokens) since they include
      // invisible thinking tokens that the user doesn't see
      const tokensUsed = response?.data?.tokens_used;
      if (tokensUsed?.reasoning?.total_tokens != null) {
        const { reasoning, response: respTokens } = tokensUsed;
        if (reasoning?.total_tokens > 0) {
          const r1 = await deductCredits(userId as string, reasoning.total_tokens, reasoning.model, {
            tokenDivisor: 300,
          });
          if (!r1.success) Logger.error(`[AI_QUERY] Failed to deduct reasoning credits for user: ${userId}`);
        }
        if (respTokens?.total_tokens > 0 && respTokens.model !== reasoning?.model) {
          const r2 = await deductCredits(userId as string, respTokens.total_tokens, respTokens.model || effectiveModel);
          if (!r2.success) Logger.error(`[AI_QUERY] Failed to deduct response credits for user: ${userId}`);
        }
      } else if (tokensUsed?.total_tokens) {
        // Fallback for old response format (single total)
        const result = await deductCredits(userId as string, tokensUsed.total_tokens, effectiveModel);
        if (!result.success) Logger.error(`[AI_QUERY] Failed to deduct credits for user: ${userId}`);
      }

      // If we silently fell back, append an italic markdown disclaimer to the answer
      if (originalModel && response.data) {
        const disclaimer =
          fallbackReason === 'premium'
            ? `\n\n*The model '${originalModel}' requires a premium plan. This response was generated using ${FALLBACK_MODEL_LABEL} instead.*`
            : fallbackReason === 'unsupported'
            ? `\n\n*The model '${originalModel}' is no longer supported. This response was generated using ${FALLBACK_MODEL_LABEL} instead.*`
            : `\n\n*The requested model '${originalModel}' was not recognized. This response was generated using ${FALLBACK_MODEL_LABEL} instead.*`;
        if (typeof response.data.answer === 'string') {
          response.data.answer += disclaimer;
        } else if (typeof response.data.response === 'string') {
          response.data.response += disclaimer;
        }
      }

      // Return the AI service response
      res.status(200).json(response.data);
    } catch (error) {
      Logger.error('Error in RAG query controller:', error);
      res.status(500).send('Internal Server Error');
    }
  },
);
// Generate optimize prompt for RAG query
contextRouter.post(
  '/generate-prompt',
  isAuthenticated,
  checkSubscriptionAndCreditLimit,
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Context']
    /* #swagger.security = [{
            "bearerAuth": []
    }] */
    try {
      const userId = req?.user?.id;
      const { query, profileId, k = 5, chatHistory = [], platform = 'chatGPT' } = req.body;

      // Validate required fields
      if (!query) {
        return res.status(400).json({ error: 'Query is required' });
      }

      // Validate query is a string and not too long
      if (typeof query !== 'string') {
        return res.status(400).json({ error: 'Query must be a string' });
      }

      if (query.trim().length === 0) {
        return res.status(400).json({ error: 'Query cannot be empty' });
      }

      // if (query.length > 10000) {
      //   return res.status(400).json({ error: 'Query is too long. Maximum length is 10000 characters.' });
      // }

      // Validate k parameter
      if (typeof k !== 'number' || k < 1 || k > 100 || !Number.isInteger(k)) {
        return res.status(400).json({ error: 'Parameter k must be an integer between 1 and 100' });
      }

      // Validate chatHistory
      const chatHistoryValidation = validateChatHistory(chatHistory);
      if (!chatHistoryValidation.valid) {
        return res.status(400).json({ error: chatHistoryValidation.error });
      }

      // no profile flow to optimized query
      if (!profileId) {
        const requestPayload = {
          query,
          userId: userId,
          profileId: '',
          k,
          chatHistory,
          platform,
        };

        // Track per-user RAG request (no profile)

        userRagRequests.inc({ user_id: userId, endpoint_type: 'agentic-rag-no-profile' });

        Logger.info(`[OPTIMIZE_PROMPT] user=${userId}, profile=none, chatHistory=${chatHistory.length}`);
        const response = await axios.post(`${process.env.AI_SERVICE_URL}/rag/optimize-prompt`, requestPayload, {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
          },
        });

        if (response.status !== 200) {
          Logger.error('Failed to query contexts from AI service');
          return res.status(500).json({ error: 'Failed to query contexts from AI service' });
        }

        // Deduct credits
        if (response?.data?.tokens_used?.total_tokens) {
          Logger.info('Deducting credits for user:', userId);
          const result = await deductCredits(
            userId as string,
            response.data?.tokens_used?.total_tokens || 1,
            response.data?.tokens_used?.model,
            { tokenDivisor: 200 },
          );
          if (!result.success) Logger.error('[OPTIMIZE_PROMPT] Failed to deduct credits for user:', userId);
        }

        // Return the AI service response
        res.status(200).json(response.data);
      } else {
        // Validate profileId is a valid UUID
        if (!isValidUUID(profileId)) {
          return res.status(400).json({ error: 'Invalid Profile ID format. Expected a valid UUID.' });
        }

        // Permission check: must have viewer+ access
        const access = await resolveProfileAccess(userId as string, profileId as string);
        if (!access.hasAccess) {
          return res.status(404).json({ error: 'Profile not found' });
        }

        const effectiveUserId = access.ownerId || userId;

        const contexts = await userContextRepository.find({
          where: { profileId },
          order: { createdAt: 'ASC' },
        });

        const contextSummaries = contexts.map((context) => JSON.stringify(context.description));

        // Call the Python AI service endpoint for optimize prompt
        const requestPayload = {
          query,
          userId: effectiveUserId || 'anonymous',
          profileId,
          k,
          chatHistory,
          contextSummary: contextSummaries,
          platform,
        };

        // Track per-user RAG request (with profile)

        userRagRequests.inc({ user_id: userId || 'anonymous', endpoint_type: 'agentic-rag-with-profile' });

        Logger.info(`[OPTIMIZE_PROMPT] user=${userId}, profile=${profileId}, chatHistory=${chatHistory.length}`);
        const response = await axios.post(`${process.env.AI_SERVICE_URL}/rag/optimize-prompt`, requestPayload, {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.AI_SERVICE_API_KEY as string,
          },
        });

        if (response.status !== 200) {
          Logger.error('Failed to query contexts from AI service');
          return res.status(500).json({ error: 'Failed to query contexts from AI service' });
        }

        // Deduct credits
        if (response?.data?.tokens_used?.total_tokens) {
          Logger.info('Deducting credits for user:', userId);
          const result = await deductCredits(
            userId as string,
            response.data?.tokens_used?.total_tokens || 1,
            response.data?.tokens_used?.model,
            { tokenDivisor: 200 },
          );
          if (!result.success) Logger.error('[OPTIMIZE_PROMPT] Failed to deduct credits for user:', userId);
        }

        // Return the AI service response
        res.status(200).json(response.data);
      }
    } catch (error) {
      Logger.error('Error in RAG query controller:', error);
      res.status(500).send('Internal Server Error');
    }
  },
);

contextRouter.get(
  '/',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  chargeMcpCall(1),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Context']
    /* #swagger.security = [{
            "bearerAuth": []
    }] */
    try {
      const userId = req?.user?.id;
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
        const access = await resolveProfileAccess(userId as string, profileId as string);
        if (!access.hasAccess) {
          return res.status(404).json({ error: 'Profile not found' });
        }

        // Get all contexts for this profile with addedBy user info
        // COALESCE: if addedBy is NULL (pre-sharing context), fall back to owner
        const rawContexts = await userContextRepository
          .createQueryBuilder('c')
          .leftJoin(User, 'u', 'u.id = COALESCE(c.addedBy, :ownerId)', { ownerId: access.ownerId })
          .select(['c.*', 'u.name AS "addedByName"', 'u.email AS "addedByEmail"', 'u.authAddress AS "addedByWallet"'])
          .where('c.profileId = :profileId', { profileId })
          .orderBy('c.createdAt', 'ASC')
          .getRawMany();

        // Add canEdit flag and addedByUser per context
        const contextsWithPermissions = rawContexts.map((ctx) => ({
          contextId: ctx.contextId,
          userId: ctx.userId,
          profileId: ctx.profileId,
          title: ctx.title,
          description: ctx.description,
          status: ctx.status,
          errorMessage: ctx.errorMessage,
          vectorIds: ctx.vectorIds,
          createdAt: ctx.createdAt,
          originalFileName: ctx.originalFileName,
          sourceType: ctx.sourceType,
          sourcePlatform: ctx.sourcePlatform,
          sourceUrl: ctx.sourceUrl,
          contentSize: ctx.contentSize,
          addedBy:
            ctx.addedByName || ctx.addedByEmail || ctx.addedByWallet
              ? {
                  id: ctx.addedBy || access.ownerId,
                  name: ctx.addedByName || null,
                  email: ctx.addedByEmail || null,
                  wallet: ctx.addedByWallet || null,
                  isOwner: !ctx.addedBy || ctx.addedBy === access.ownerId,
                }
              : // addedBy set but user deleted, or no user record found
                { id: ctx.addedBy || access.ownerId, name: null, isOwner: !ctx.addedBy },
          canEdit: canEditContext(access, ctx as UserContext, userId),
        }));

        return res.status(200).json({ contexts: contextsWithPermissions });
      }

      // No profileId — return only the user's own contexts
      const contexts = await userContextRepository.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      });

      res.status(200).json({ contexts });
    } catch (error) {
      Logger.error('Error fetching user contexts:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },
);

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

contextRouter.get('/:contextId', isAuthenticatedNativeOrMcp('mcp:tools'), async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Context']
  /* #swagger.security = [{
            "bearerAuth": []
    }] */
  try {
    const userId = req?.user?.id;
    const { contextId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Validate contextId is a valid UUID
    if (!isValidUUID(contextId)) {
      return res.status(400).json({ error: 'Invalid Context ID format. Expected a valid UUID.' });
    }

    const context = await userContextRepository.findOne({
      where: { contextId: contextId as string },
    });

    if (!context) {
      return res.status(404).json({ error: 'Context not found' });
    }

    // Permission check: must have viewer+ access to the parent bucket
    const access = await resolveProfileAccess(userId as string, context.profileId);
    if (!access.hasAccess) {
      return res.status(404).json({ error: 'Context not found' });
    }

    res.status(200).json({
      context: {
        ...context,
        canEdit: canEditContext(access, context, userId),
      },
    });
  } catch (error) {
    Logger.error('Error fetching user contexts:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /ai/context/:contextId/content — read context content with pagination
// Proxies to AI service's GET /rag/get-context-data (used by MCP read_context tool)
contextRouter.get(
  '/:contextId/content',
  isAuthenticatedNativeOrMcp('mcp:tools'),
  chargeMcpCall(5),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['AI-Context']
    /* #swagger.security = [{ "bearerAuth": [] }] */
    try {
      const userId = req?.user?.id;
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

      const access = await resolveProfileAccess(userId as string, context.profileId);
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
        sourceUrl: context.sourceUrl || '',
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
    const access = await resolveProfileAccess(userId as string, userContext.profileId);
    if (!access.hasAccess || !canEditContext(access, userContext, userId)) {
      return res.status(403).json({ error: 'You do not have permission to delete this context' });
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

    // Fire-and-forget: activity log + notifications
    logActivity(deletedProfileId, userId as string, 'context_deleted', {
      targetType: 'context',
      targetId: contextId,
      metadata: { title: deletedTitle },
    });
    notifyShareMembers(
      deletedProfileId,
      userId as string,
      'context_deleted',
      `Context '${deletedTitle}' was deleted`,
      undefined,
      {
        profileId: deletedProfileId,
        contextId,
      },
    );

    res.status(200).json({
      message: 'Context deleted successfully',
      contextId: contextId,
    });
  } catch (error) {
    Logger.error('Error deleting user context:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET: Check credits for IP address (public endpoint)
contextRouter.get('/credits', async (req: Request, res: Response) => {
  // #swagger.tags = ['AI-Context']
  try {
    const clientIP = getClientIP(req);
    if (!clientIP) {
      return res.status(400).json({ error: 'Unable to identify client IP' });
    }

    const ipCredit = await getOrCreateIpCredit(clientIP);

    res.status(200).json({
      ipAddress: clientIP,
      credits: ipCredit.credits,
      tokensUsed: ipCredit.tokensUsed,
      createdAt: ipCredit.createdAt,
      updatedAt: ipCredit.updatedAt,
    });
  } catch (error) {
    Logger.error('Error fetching IP credits:', error);
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
  checkSubscriptionAndCreditLimit,
  handleMultipart,
  checkContextSizeLimitMiddleware,
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
      const access = await resolveProfileAccess(userId as string, profileId as string);
      if (!access.hasAccess || !hasMinRole(access, 'editor')) {
        return res.status(404).json({ error: 'Profile not found or insufficient permissions' });
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
        addedBy: userId,
      });
      await userContextRepository.save(userContext);

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

      // Fire-and-forget: activity log + notifications
      logActivity(profileId, userId as string, 'context_added', {
        targetType: 'context',
        targetId: contextId,
        metadata: { title: userContext.title, sourceType: 'file', fileName: req.file.originalname },
      });
      notifyShareMembers(
        profileId,
        userId as string,
        'context_added',
        `A new file '${userContext.title}' was added to '${profile.profileName}'`,
        undefined,
        {
          profileId,
          contextId,
          profileName: profile.profileName,
        },
      );

      // Deduct credits
      if (response?.data?.tokens_used?.total_tokens) {
        Logger.info('Deducting credits for user:', userId);
        const result = await deductCredits(
          userId as string,
          response.data?.tokens_used?.total_tokens || 1,
          response.data?.tokens_used?.model,
        );
        if (!result.success) Logger.error('[UPLOAD_FILE] Failed to deduct credits for user:', userId);
      }

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
              sourceUrl: userContext.sourceUrl,
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
