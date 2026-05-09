import { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../../../data-source';
import { UserSubscription } from '../entity/user-subscription';
import { SubscriptionTransition, TransitionStatus } from '../entity/subscription-transition';
import { UserAiProfile } from '../../ai-service/entity/user-ai-profile';
import Logger from '../../../lib/logger';
import {
  getOrCreateUserSubscription,
  isSubscriptionValid,
  shouldResetCredits,
  getSubscriptionPlan,
  checkContextSizeLimit,
  formatBytes,
} from '../utils';
import { isModelAllowedForTier, getModelTier, getModelConfig as getModelCfg } from '../model-tiers';
import { validate as isValidUUID } from 'uuid';
import { resolveProfileAccess, hasMinRole } from '../../ai-service/utils/permission';

// Repository instances
const userSubscriptionRepository = AppDataSource.getRepository(UserSubscription);
const userAiProfileRepository = AppDataSource.getRepository(UserAiProfile);

/**
 * Middleware to check subscription status and credits before allowing access
 * This middleware checks:
 * 1. If user has FREE plan - ensures they have credits remaining
 * 2. If user has paid plan - ensures subscription hasn't expired
 * 3. Automatically resets free credits monthly
 * 4. Downgrades expired paid subscriptions to FREE
 */
export const checkSubscriptionAndCreditLimit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'User ID not found in token',
        code: 'UNAUTHORIZED',
      });
    }
    Logger.info(`Checking subscription access for user: ${userId}`);
    // Get or create user subscription
    const userSubscription = await getOrCreateUserSubscription(userId);

    // Check if we need to reset daily credits
    if (shouldResetCredits(userSubscription)) {
      const currentPlan = getSubscriptionPlan(userSubscription.planType);
      Logger.info(`Resetting daily credits for user: ${userId}`);
      if (currentPlan) {
        userSubscription.creditsRemaining = currentPlan.dailyCredits;
        userSubscription.creditsUsed = 0;
        userSubscription.lastResetAt = new Date();
        await userSubscriptionRepository.save(userSubscription);
        Logger.info(`Reset daily credits for user: ${userId}, plan: ${userSubscription.planType}`);
      }
    }

    // Check if paid subscription has expired
    const isValid = await isSubscriptionValid(userSubscription);
    if (!isValid && userSubscription.planType !== 'FREE') {
      Logger.info(`Downgrading expired subscription to FREE for user: ${userId}`);
      // Downgrade expired subscription to FREE
      const freePlan = getSubscriptionPlan('FREE');
      if (freePlan) {
        // Use transaction to ensure subscription downgrade and transition update are atomic
        await AppDataSource.transaction(async (transactionalEntityManager) => {
          userSubscription.planType = 'FREE';
          userSubscription.creditsRemaining = freePlan.dailyCredits;
          userSubscription.expiresAt = null;
          userSubscription.lastResetAt = new Date();
          await transactionalEntityManager.save(UserSubscription, userSubscription);
          Logger.info(`Downgraded expired subscription to FREE for user: ${userId}`);

          // Mark any pending transition to FREE as completed
          const pendingTransition = await transactionalEntityManager.findOne(SubscriptionTransition, {
            where: {
              userId,
              toPlanType: 'FREE',
              status: TransitionStatus.PENDING,
            },
            order: { createdAt: 'DESC' },
          });
          if (pendingTransition) {
            pendingTransition.status = TransitionStatus.COMPLETED;
            pendingTransition.completedAt = new Date();
            await transactionalEntityManager.save(SubscriptionTransition, pendingTransition);
            Logger.info(`Marked pending transition ${pendingTransition.id} as COMPLETED for user: ${userId}`);
          }
        });
      }

      Logger.info(`Subscription has expired for user: ${userId}`);
      return res.status(402).json({
        error: 'Subscription has expired. Please renew your subscription.',
        code: 'SUBSCRIPTION_EXPIRED',
        subscription: {
          planType: userSubscription.planType,
          expiresAt: userSubscription.expiresAt,
          wasDowngradedTo: 'FREE',
        },
      });
    }

    // Now check access permissions based on plan type
    Logger.info(`Checking free credits for user: ${userId}`);
    // For  any plan, check if credits are available
    if (userSubscription.creditsRemaining <= 0) {
      Logger.info(`No credits remaining for user: ${userId}`);
      return res.status(402).json({
        error: 'No credits remaining. Please upgrade your subscription or wait for daily reset.',
        code: 'INSUFFICIENT_CREDITS',
        subscription: {
          planType: userSubscription.planType,
          creditsRemaining: userSubscription.creditsRemaining,
          nextResetDate: userSubscription.lastResetAt
            ? new Date(userSubscription.lastResetAt.getTime() + 24 * 60 * 60 * 1000)
            : null,
        },
      });
    }

    // Add subscription info to request for potential use in route handlers
    req.subscription = {
      id: userSubscription.id,
      planType: userSubscription.planType,
      creditsRemaining: userSubscription.creditsRemaining,
      expiresAt: userSubscription.expiresAt,
      isValid: isValid,
    };

    // Access granted - proceed to next middleware/route handler
    next();
  } catch (error) {
    Logger.error('Error in subscription access check:', error);
    res.status(500).json({
      error: 'Internal Server Error during subscription check',
      code: 'SUBSCRIPTION_CHECK_ERROR',
    });
  }
};

// ============================================
// Context Size Limit Middleware
// ============================================

/**
 * Middleware to check context size limit before context creation
 * This middleware checks:
 * 1. Estimates the size of incoming content (file, chat, or raw text)
 * 2. Checks if adding the content would exceed the user's storage limit
 * 3. Returns 402 if limit would be exceeded
 * 4. Otherwise, allows access to continue
 */
export const checkContextSizeLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req?.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'User ID not found in token',
        code: 'UNAUTHORIZED',
      });
    }

    // Estimate size of incoming content
    let estimatedSize = 0;

    // For file uploads (multer adds file to request)
    if (req.file) {
      estimatedSize = req.file.size;
      Logger.info(`File upload detected: ${req.file.originalname}, size: ${formatBytes(estimatedSize)}`);
    }
    // For chat context
    else if (req.body.chatHistory) {
      const chatContent = req.body.chatHistory?.map((m: { content: string }) => m.content || '').join('\n') || '';
      estimatedSize = Buffer.byteLength(chatContent, 'utf8');
      Logger.info(`Chat context detected, estimated size: ${formatBytes(estimatedSize)}`);
    }
    // For raw text context
    else if (req.body.context) {
      estimatedSize = Buffer.byteLength(req.body.context, 'utf8');
      Logger.info(`Raw text context detected, estimated size: ${formatBytes(estimatedSize)}`);
    }

    // Storage is accounted against the profile OWNER's quota, not the actor's.
    // Context rows are persisted with UserContext.userId = profile.userId (the owner),
    // so the storage total grows under the owner. If this is a shared profile and the
    // caller has editor access, gate against the owner's plan — otherwise editors on
    // huge shared profiles get false rejections and owners can silently overflow.
    // When no profileId is present (new profile flow) the actor becomes the owner,
    // so gating against the actor is correct.
    const profileId = req.body?.profileId;
    let targetUserId = userId;
    let targetIsSharedOwner = false;

    if (profileId && typeof profileId === 'string' && isValidUUID(profileId)) {
      const access = await resolveProfileAccess(userId, profileId);
      if (access.hasAccess && hasMinRole(access, 'editor') && !access.isOwner && access.ownerId) {
        targetUserId = access.ownerId;
        targetIsSharedOwner = true;
      }
    }

    const limitCheck = await checkContextSizeLimit(targetUserId, estimatedSize);

    Logger.info(
      `Actor ${userId} -> target ${targetUserId}${targetIsSharedOwner ? ' (shared owner)' : ''} ` +
        `context size: ${formatBytes(limitCheck.currentSize)} / ${formatBytes(limitCheck.maxSize)}, ` +
        `adding ${formatBytes(estimatedSize)}, exceeded: ${limitCheck.exceeded}`,
    );

    if (limitCheck.exceeded) {
      return res.status(402).json({
        error: targetIsSharedOwner
          ? "This shared profile's owner has no storage left. Ask the owner to free up space or upgrade their plan."
          : 'Context storage limit exceeded. Please upgrade your subscription for more storage.',
        code: 'CONTEXT_SIZE_LIMIT_EXCEEDED',
        details: {
          sharedProfile: targetIsSharedOwner,
          currentSize: limitCheck.currentSize,
          maxSize: limitCheck.maxSize,
          remainingSize: limitCheck.remainingSize,
          attemptedToAdd: estimatedSize,
          currentSizeFormatted: formatBytes(limitCheck.currentSize),
          maxSizeFormatted: formatBytes(limitCheck.maxSize),
          remainingSizeFormatted: formatBytes(limitCheck.remainingSize),
          attemptedToAddFormatted: formatBytes(estimatedSize),
        },
      });
    }

    // Add limit info to request for potential use in route handlers
    (req as any).contextSizeLimit = {
      currentSize: limitCheck.currentSize,
      maxSize: limitCheck.maxSize,
      remainingSize: limitCheck.remainingSize,
    };

    Logger.info(`Context size limit check passed for user: ${userId}`);
    next();
  } catch (error) {
    Logger.error('Error in context size limit check:', error);
    res.status(500).json({
      error: 'Internal Server Error during context size limit check',
      code: 'CONTEXT_SIZE_LIMIT_CHECK_ERROR',
    });
  }
};

// ============================================
// Model Access Middleware
// ============================================

/**
 * Middleware to check if the requested model is allowed for the user's plan tier.
 * Must run AFTER checkSubscriptionAndCreditLimit (which sets req.subscription).
 * Reads the model key from req.body.model (defaults to 'gemini' if not provided).
 */
export const checkModelAccess = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestedModel = req.body.model || 'gemini';
    const planType = req.subscription?.planType;

    if (!planType) {
      return res.status(401).json({
        error: 'Subscription info not found. Ensure subscription check runs first.',
        code: 'UNAUTHORIZED',
      });
    }

    const plan = getSubscriptionPlan(planType);
    if (!plan) {
      return res.status(500).json({
        error: 'Could not resolve subscription plan.',
        code: 'PLAN_NOT_FOUND',
      });
    }

    if (!isModelAllowedForTier(requestedModel, plan.modelTier)) {
      const modelTier = getModelTier(requestedModel);
      const isKnownModel = !!getModelCfg(requestedModel);
      const reason = isKnownModel ? 'premium' : 'unsupported';
      Logger.info(
        `Model access denied — silent fallback (${reason}). Plan: ${planType} (${plan.modelTier}), ` +
          `Requested model: ${requestedModel} (${modelTier})`,
      );
      // Silent fallback: swap to base-tier default and let controller append disclaimer
      (req as any).modelFallbackFrom = requestedModel;
      (req as any).modelFallbackReason = reason;
      req.body.model = 'gemini-2.5-flash';
    }

    next();
  } catch (error) {
    Logger.error('Error in model access check:', error);
    res.status(500).json({
      error: 'Internal Server Error during model access check',
      code: 'MODEL_ACCESS_CHECK_ERROR',
    });
  }
};
