import { UserSubscription } from '../entity/user-subscription';
import { AppDataSource } from '../../../data-source';
import Logger from '../../../lib/logger';
import { User } from '../../user-service/entity/user';
import { UserContext } from '../../ai-service/entity/user-context';
import {
  getSubscriptionPlans as getPlansFromConst,
  getSubscriptionPlan as getPlanFromConst,
  getAppSumoPlans as getAppSumoPlansFromConst,
  PlanConfig,
} from '../plans';
import { getModelsForTier, getAllModels, getCreditMultiplier, getDefaultModelForPlan, ModelTier } from '../model-tiers';

// Repository instances
const userSubscriptionRepository = AppDataSource.getRepository(UserSubscription);
const userRepository = AppDataSource.getRepository(User);

// Re-export plan lookups from constants (synchronous, no DB)
export const getSubscriptionPlans = getPlansFromConst;
export const getSubscriptionPlan = getPlanFromConst;
export const getAppSumoPlans = getAppSumoPlansFromConst;

// Returns true if the subscription is on any paid plan (not FREE).
// AppSumo lifetime tiers count as paid.
export const isPaidPlan = (subscription: UserSubscription): boolean => {
  return subscription.planType !== 'FREE';
};

// Helper function to get or create user subscription
export const getOrCreateUserSubscription = async (userId: string): Promise<UserSubscription> => {
  let subscription = await userSubscriptionRepository.findOne({
    where: { userId },
  });

  if (!subscription) {
    const freePlan = getSubscriptionPlan('FREE');

    if (!freePlan) {
      throw new Error('FREE subscription plan not found in constants.');
    }

    subscription = userSubscriptionRepository.create({
      userId,
      planType: 'FREE',
      creditsRemaining: freePlan.dailyCredits,
      creditsUsed: 0,
      expiresAt: null,
      lastResetAt: new Date(),
    });
    await userSubscriptionRepository.save(subscription);

    Logger.info(`Created new FREE subscription for user: ${userId}`);
  }

  return subscription!;
};

// Helper function to check if subscription has expired
export const isSubscriptionValid = async (subscription: UserSubscription): Promise<boolean> => {
  if (subscription.planType === 'FREE') {
    return true; // Free plans don't expire
  }

  // Treat AppSumo lifetime plans as perpetual
  const appSumoPlanTypes = ['APPSUMO_TIER_1', 'APPSUMO_TIER_2', 'APPSUMO_TIER_3'];
  if (appSumoPlanTypes.includes(subscription.planType)) {
    return true;
  }

  // Paid plans must have expiry date
  if (!subscription.expiresAt) {
    return false;
  }

  return new Date() < subscription.expiresAt;
};

// Helper function to check if daily credit reset is needed
export const shouldResetCredits = (subscription: UserSubscription): boolean => {
  if (!subscription.lastResetAt) {
    return true;
  }

  const now = new Date();
  const lastReset = subscription.lastResetAt;
  const msInDay = 24 * 60 * 60 * 1000;
  const daysSinceReset = Math.floor((now.getTime() - lastReset.getTime()) / msInDay);

  return daysSinceReset >= 1;
};

// Interface for deduct credits result
export interface DeductCreditsResult {
  success: boolean;
  creditsRemaining: number;
  message: string;
  subscriptionId: string;
}

// Function to deduct credits from user subscription
// modelKey is optional — when provided, the credit cost is multiplied by the model's creditMultiplier (1x/2x/3x)
// tokenDivisor — tokens per credit. Defaults to 100. Use higher values to discount tokens that
//   aren't directly user-facing (e.g. 300 for heavy reasoning with thinking tokens, 200 for other
//   background LLM work like prompt optimization).
export const deductCredits = async (
  userId: string,
  tokensUsed: number,
  modelKey?: string,
  { tokenDivisor = 100 }: { tokenDivisor?: number } = {},
): Promise<DeductCreditsResult> => {
  try {
    // Validate input parameters
    if (!userId) {
      throw new Error('User ID is required');
    }

    const userSubscription = await userSubscriptionRepository.findOne({
      where: { userId: userId },
    });

    if (!userSubscription) {
      throw new Error('User Subscription not found');
    }

    const multiplier = modelKey ? getCreditMultiplier(modelKey) : 1;
    const baseCost = Math.ceil(tokensUsed / tokenDivisor);
    const creditCost = baseCost * multiplier;
    userSubscription.creditsRemaining = Math.max(0, userSubscription.creditsRemaining - creditCost);
    userSubscription.creditsUsed += creditCost;

    // Save the updated subscription
    await userSubscriptionRepository.save(userSubscription);

    // Log the successful deduction
    Logger.info(
      `Successfully deducted ${creditCost} credits (${multiplier}x, 1/${tokenDivisor}) from user ${userId}. Remaining: ${
        userSubscription.creditsRemaining
      } (${tokensUsed} tokens, model: ${modelKey || 'default'})`,
    );

    return {
      success: true,
      creditsRemaining: userSubscription.creditsRemaining,
      message: `Successfully deducted ${creditCost} credits. ${userSubscription.creditsRemaining} credits remaining.`,
      subscriptionId: userSubscription?.id || '',
    };
  } catch (error) {
    Logger.error(`Error deducting credits for user ${userId}:`, error);
    return {
      success: false,
      creditsRemaining: 0,
      message: `Error deducting credits for user ${userId}: ${error}`,
      subscriptionId: '',
    };
  }
};

// Plan change direction enum
export enum PlanChangeDirection {
  UPGRADE = 'UPGRADE',
  DOWNGRADE = 'DOWNGRADE',
  SAME = 'SAME',
}

// Interface for plan change analysis
export interface PlanChangeAnalysis {
  direction: PlanChangeDirection;
  shouldProrateImmediately: boolean;
  shouldScheduleForLater: boolean;
  rationale: string;
}

/**
 * Determine if a plan change is an upgrade or downgrade
 * Rules (Money-first approach):
 * 1. Upgrades (to higher price or yearly commitment) → Reset billing NOW with PRORATION
 * 2. Downgrades (to lower price or monthly from yearly) → Reset billing LATER with NO PRORATION
 * 3. Same plan → No change
 */
export const analyzePlanChange = (currentPlanType: string, targetPlanType: string): PlanChangeAnalysis => {
  // Same plan - no change
  if (currentPlanType === targetPlanType) {
    return {
      direction: PlanChangeDirection.SAME,
      shouldProrateImmediately: false,
      shouldScheduleForLater: false,
      rationale: 'No change - same plan',
    };
  }

  // Parse plan types to extract tier and billing cycle
  const parsePlan = (planType: string) => {
    let tier: string;
    if (planType.includes('PRO')) {
      tier = 'PRO';
    } else if (planType.includes('PLUS')) {
      tier = 'PLUS';
    } else {
      tier = 'FREE';
    }
    const billing = planType.includes('YEARLY') ? 'YEARLY' : planType.includes('MONTHLY') ? 'MONTHLY' : 'NONE';
    return { tier, billing };
  };

  const current = parsePlan(currentPlanType);
  const target = parsePlan(targetPlanType);

  // Tier hierarchy: PRO > PLUS > FREE

  const tierValue: { [key: string]: number } = { FREE: 0, PLUS: 1, PRO: 2 };
  const currentTierValue = tierValue[current.tier];
  const targetTierValue = tierValue[target.tier];

  // Billing cycle value: YEARLY > MONTHLY > NONE

  const billingValue: { [key: string]: number } = { NONE: 0, MONTHLY: 1, YEARLY: 2 };
  const currentBillingValue = billingValue[current.billing];
  const targetBillingValue = billingValue[target.billing];

  // Determine if it's an upgrade or downgrade
  let isUpgrade = false;
  let rationale = '';

  // Case 1: Tier upgrade (e.g., PLUS → PRO)
  if (targetTierValue > currentTierValue) {
    // Tier upgrade is always immediate
    isUpgrade = true;
    rationale = 'This change will be effective immediately.';
  }
  // Case 2: Tier downgrade (e.g., PRO → PLUS)
  else if (targetTierValue < currentTierValue) {
    if (targetTierValue === 0) {
      // Moving to FREE plan
      // Tier downgrade to FREE is always scheduled for later
      isUpgrade = false;
      rationale = 'This change will take effect at the end of your current billing period.';
    } else if (targetBillingValue === currentBillingValue) {
      // Same billing cycle
      // Tier downgrade with no billing cycle change is always scheduled for later
      isUpgrade = false;
      rationale = 'This change will take effect at the end of your current billing period.';
    } else {
      // Tier downgrade with billing cycle change (e.g. PRO_YEARLY → PLUS_MONTHLY).
      // Stripe requires immediate billing when changing price intervals — cannot schedule.
      // Treated as immediate with proration credit for unused time.
      isUpgrade = true;
      rationale = 'This change will be effective immediately.';
    }
  }
  // Case 3: Same tier, but billing cycle change
  else if (currentTierValue === targetTierValue && currentTierValue > 0) {
    if (targetBillingValue > currentBillingValue) {
      // Moving from monthly to yearly = upgrade (longer commitment)
      // Billing cycle change is changed charged immidiately because stripe requires it
      isUpgrade = true;
      rationale = 'This change will be effective immediately.';
    } else if (targetBillingValue < currentBillingValue) {
      // Moving from yearly to monthly = downgrade, but Stripe requires immediate billing
      // when changing price intervals (yearly ↔ monthly) — billing_cycle_anchor: 'unchanged'
      // is rejected. Treated as immediate with proration credit for unused time.
      isUpgrade = true;
      rationale = 'This change will be effective immediately.';
    }
  }
  // Case 4: Moving from FREE to paid
  else if (current.tier === 'FREE' && target.tier !== 'FREE') {
    // FREE to paid is always immediate
    isUpgrade = true;
    rationale = 'Upgrade from free to paid plan.';
  }

  return {
    direction: isUpgrade ? PlanChangeDirection.UPGRADE : PlanChangeDirection.DOWNGRADE,
    shouldProrateImmediately: isUpgrade,
    shouldScheduleForLater: !isUpgrade,
    rationale,
  };
};

export const getSubscriptionDetails = async (userId: string) => {
  try {
    const subscription = await getOrCreateUserSubscription(userId);

    // Check if we need to reset daily credits
    if (shouldResetCredits(subscription)) {
      const currentPlan = getSubscriptionPlan(subscription.planType);
      if (currentPlan) {
        subscription.creditsRemaining = currentPlan.dailyCredits;
        subscription.creditsUsed = 0;
        subscription.lastResetAt = new Date();
        await userSubscriptionRepository.save(subscription);
        Logger.info(`Reset daily credits for user: ${userId}, plan: ${subscription.planType}`);
      }
    }

    // Check if paid subscription has expired
    const isValid = await isSubscriptionValid(subscription);
    if (!isValid && subscription.planType !== 'FREE') {
      // Downgrade expired subscription to FREE
      const freePlan = getSubscriptionPlan('FREE');
      if (freePlan) {
        subscription.planType = 'FREE';
        subscription.creditsRemaining = freePlan.dailyCredits;
        subscription.expiresAt = null;
        subscription.lastResetAt = new Date();
        await userSubscriptionRepository.save(subscription);
        Logger.info(`Downgraded expired subscription to FREE for user: ${userId}`);
      }
    }

    const currentPlan = getSubscriptionPlan(subscription.planType);
    const user = await userRepository.findOne({
      where: {
        id: userId,
      },
    });

    return {
      id: subscription.id,
      email: user?.email,
      walletAddress: user?.authAddress,
      planType: subscription.planType,
      displayName: currentPlan?.displayName || subscription.planType,
      displayNameShort: currentPlan?.displayNameShort || subscription.planType,
      amount: currentPlan?.price || 0,
      currency: currentPlan?.currency || 'USD',
      dailyCredits: currentPlan?.dailyCredits || 0,
      creditsRemaining: subscription.creditsRemaining,
      creditsUsed: subscription.creditsUsed,
      expiresAt: subscription.expiresAt,
      lastResetAt: subscription.lastResetAt,
      isValid: isValid,
      canUpgrade: subscription.planType === 'FREE' || !isValid,
      // subscriptionStatus: subscription.subscriptionStatus,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      isRecurring: !!subscription.stripeSubscriptionId,
      modelTier: (currentPlan?.modelTier || 'base') as ModelTier,
      // Plan-specific default model — clients use this as the fallback when
      // the user has no preferredModel set yet (or theirs was cleared).
      defaultModel: getDefaultModelForPlan(subscription.planType),
      allowedModels: getModelsForTier((currentPlan?.modelTier || 'base') as ModelTier).map((m) => ({
        key: m.key,
        displayName: m.displayName,
        description: m.description,
        provider: m.provider,
        tier: m.tier,
        creditMultiplier: m.creditMultiplier,
        speedTier: m.speedTier,
        featured: m.featured,
      })),
      allModels: getAllModels().map((m) => ({
        key: m.key,
        displayName: m.displayName,
        description: m.description,
        provider: m.provider,
        tier: m.tier,
        creditMultiplier: m.creditMultiplier,
        speedTier: m.speedTier,
        featured: m.featured,
      })),
    };
  } catch (error) {
    Logger.error(`Error getting subscription details for user ${userId}:`, error);
    throw error;
  }
};

// ============================================
// Context Size Limit Utilities
// ============================================

/**
 * Convert character count to estimated bytes (UTF-8)
 * UTF-8 uses 1 byte for ASCII, 2-3 bytes for common characters, up to 4 bytes for rare ones
 * Using 1.5 as a reasonable average multiplier
 * @param charCount - Number of characters
 * @returns Estimated size in bytes
 */
export const estimateBytesFromCharCount = (charCount: number): number => {
  return Math.ceil(charCount * 1.5);
};

/**
 * Format bytes to human-readable string
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "10.5 MB")
 */
export const formatBytes = (bytes: number): string => {
  if (bytes === -1) return 'Unlimited';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
};

/**
 * Calculate total context size for a user across all profiles
 * @param userId - User ID
 * @returns Total size in bytes
 */
export const getUserTotalContextSize = async (userId: string): Promise<number> => {
  try {
    const userContextRepository = AppDataSource.getRepository(UserContext);

    const result = await userContextRepository
      .createQueryBuilder('context')
      .select('COALESCE(SUM(context.contentSize), 0)', 'totalSize')
      .where('context.userId = :userId', { userId })
      .getRawOne();

    return parseInt(result?.totalSize || '0', 10);
  } catch (error) {
    Logger.error(`Error calculating total context size for user ${userId}:`, error);
    return 0;
  }
};

/**
 * Get context size limit from subscription plan
 * @param subscription - User subscription
 * @returns Max context size in bytes (-1 for unlimited)
 */
export const getContextSizeLimit = (subscription: UserSubscription): number => {
  const plan = getSubscriptionPlan(subscription.planType);
  return plan?.maxContextSizeBytes ?? 10485760; // Default to 10 MB
};

/**
 * Check if adding new content would exceed the context size limit
 * @param userId - User ID
 * @param newContentSize - Size of new content to add (in bytes)
 * @returns Object with exceeded status and details
 */
export const checkContextSizeLimit = async (
  userId: string,
  newContentSize: number,
): Promise<{
  exceeded: boolean;
  currentSize: number;
  maxSize: number;
  remainingSize: number;
}> => {
  const subscription = await getOrCreateUserSubscription(userId);
  const maxSize = getContextSizeLimit(subscription);
  const currentSize = await getUserTotalContextSize(userId);

  // -1 means unlimited
  if (maxSize === -1) {
    return {
      exceeded: false,
      currentSize,
      maxSize: -1,
      remainingSize: -1,
    };
  }

  const wouldExceed = currentSize + newContentSize > maxSize;

  return {
    exceeded: wouldExceed,
    currentSize,
    maxSize,
    remainingSize: Math.max(0, maxSize - currentSize),
  };
};

/**
 * Get context size limits and usage for a user
 * @param userId - User ID
 * @returns Object with current usage and limits
 */
export const getContextSizeLimits = async (
  userId: string,
): Promise<{
  currentSize: number;
  maxSize: number;
  remainingSize: number;
  percentUsed: number;
  currentSizeFormatted: string;
  maxSizeFormatted: string;
  remainingSizeFormatted: string;
}> => {
  try {
    const subscription = await getOrCreateUserSubscription(userId);
    const plan = getSubscriptionPlan(subscription.planType);
    const maxSize = plan?.maxContextSizeBytes || 0;
    const currentSize = await getUserTotalContextSize(userId);
    const remainingSize = Math.max(0, maxSize - currentSize);
    const percentUsed = Math.min(100, (currentSize / maxSize) * 100);

    return {
      currentSize,
      maxSize,
      remainingSize,
      percentUsed: Math.round(percentUsed * 100) / 100, // Round to 2 decimal places
      currentSizeFormatted: formatBytes(currentSize),
      maxSizeFormatted: formatBytes(maxSize),
      remainingSizeFormatted: formatBytes(remainingSize),
    };
  } catch (error) {
    Logger.error(`Error getting context size limits for user ${userId}:`, error);
    return {
      currentSize: 0,
      maxSize: 0,
      remainingSize: 0,
      percentUsed: 0,
      currentSizeFormatted: '0 B',
      maxSizeFormatted: '00.0 MB',
      remainingSizeFormatted: '0.0 MB',
    };
  }
};
