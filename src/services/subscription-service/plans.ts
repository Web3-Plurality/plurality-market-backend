import * as dotenv from 'dotenv';
import { ModelTier } from './model-tiers';

dotenv.config();

// ============================================================================
// WARNING: DO NOT DELETE PLANS FROM THIS ARRAY.
// Existing users may have active subscriptions referencing these plans.
// To retire a plan, set isActive: false — this hides it from new purchases
// but keeps it working for existing subscribers.
//
// When adding or removing a plan, you MUST update EXPECTED_PLAN_COUNT below.
// The app will refuse to start if the count doesn't match.
// ============================================================================

const EXPECTED_PLAN_COUNT = 8;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export interface PlanConfig {
  name: string;
  displayName: string;
  displayNameShort: string;
  description: string;
  price: number;
  currency: string;
  stripePriceId: string | null;
  dailyCredits: number;
  features: string[];
  durationInMonths: number;
  isActive: boolean;
  sortOrder: number;
  maxContextSizeBytes: number;
  modelTier: ModelTier;
}

const PLANS: PlanConfig[] = [
  {
    name: 'FREE',
    displayName: 'Free',
    displayNameShort: 'Free',
    description: 'Get started with essential AI features',
    price: 0,
    currency: 'USD',
    stripePriceId: null,
    dailyCredits: 200,
    features: ['200 Credits per day', '50 MB Memory Capacity', 'Base Models', 'MCP Server & Context Sharing'],
    durationInMonths: 0,
    isActive: true,
    sortOrder: 1,
    maxContextSizeBytes: 52428800, // 50 MB
    modelTier: 'base',
  },
  {
    name: 'PLUS_MONTHLY',
    displayName: 'Plus Monthly',
    displayNameShort: 'Plus',
    description: 'More power for serious users',
    price: 10,
    currency: 'USD',
    stripePriceId: requireEnv('STRIPE_PRICE_PLUS_MONTHLY'),
    dailyCredits: 1500,
    features: ['1,500 Credits per day', '500 MB Memory Capacity', 'Base Models', 'MCP Server & Context Sharing'],
    durationInMonths: 1,
    isActive: true,
    sortOrder: 2,
    maxContextSizeBytes: 524288000, // 500 MB
    modelTier: 'base',
  },
  {
    name: 'PLUS_YEARLY',
    displayName: 'Plus Yearly',
    displayNameShort: 'Plus',
    description: 'More power for serious users — Save with annual billing',
    price: 99,
    currency: 'USD',
    stripePriceId: requireEnv('STRIPE_PRICE_PLUS_YEARLY'),
    dailyCredits: 1500,
    features: ['1,500 Credits per day', '500 MB Memory Capacity', 'Base Models', 'MCP Server & Context Sharing'],
    durationInMonths: 12,
    isActive: true,
    sortOrder: 3,
    maxContextSizeBytes: 524288000, // 500 MB
    modelTier: 'base',
  },
  {
    name: 'PRO_MONTHLY',
    displayName: 'Pro Monthly',
    displayNameShort: 'Pro',
    description: 'Maximum performance with premium models',
    price: 20,
    currency: 'USD',
    stripePriceId: requireEnv('STRIPE_PRICE_PRO_MONTHLY'),
    dailyCredits: 5000,
    features: ['5,000 Credits per day', '5 GB Memory Capacity', 'Premium Models', 'MCP Server & Context Sharing'],
    durationInMonths: 1,
    isActive: true,
    sortOrder: 4,
    maxContextSizeBytes: 5368709120, // 5 GB
    modelTier: 'premium',
  },
  {
    name: 'PRO_YEARLY',
    displayName: 'Pro Yearly',
    displayNameShort: 'Pro',
    description: 'Maximum performance with premium models — Save with annual billing',
    price: 199,
    currency: 'USD',
    stripePriceId: requireEnv('STRIPE_PRICE_PRO_YEARLY'),
    dailyCredits: 5000,
    features: ['5,000 Credits per day', '5 GB Memory Capacity', 'Premium Models', 'MCP Server & Context Sharing'],
    durationInMonths: 12,
    isActive: true,
    sortOrder: 5,
    maxContextSizeBytes: 5368709120, // 5 GB
    modelTier: 'premium',
  },
  // AppSumo tiers (hidden from regular plans list)
  {
    name: 'APPSUMO_TIER_1',
    displayName: 'AppSumo Tier 1',
    displayNameShort: 'AppSumo T1',
    description: 'AppSumo lifetime deal - Tier 1',
    price: 59,
    currency: 'USD',
    stripePriceId: null,
    dailyCredits: 1667,
    features: ['1,667 Credits per day', '1 GB Memory Capacity', 'Base Models', 'Lifetime access'],
    durationInMonths: 0,
    isActive: false,
    sortOrder: 200,
    maxContextSizeBytes: 1073741824, // 1 GB
    modelTier: 'base',
  },
  {
    name: 'APPSUMO_TIER_2',
    displayName: 'AppSumo Tier 2',
    displayNameShort: 'AppSumo T2',
    description: 'AppSumo lifetime deal - Tier 2',
    price: 149,
    currency: 'USD',
    stripePriceId: null,
    dailyCredits: 5000,
    features: ['5,000 Credits per day', '5 GB Memory Capacity', 'Base Models', 'Lifetime access'],
    durationInMonths: 0,
    isActive: false,
    sortOrder: 201,
    maxContextSizeBytes: 5368709120, // 5 GB
    modelTier: 'base',
  },
  {
    name: 'APPSUMO_TIER_3',
    displayName: 'AppSumo Tier 3',
    displayNameShort: 'AppSumo T3',
    description: 'AppSumo lifetime deal - Tier 3',
    price: 339,
    currency: 'USD',
    stripePriceId: null,
    dailyCredits: 15000,
    features: ['15,000 Credits per day', '10 GB Memory Capacity', 'Premium Models', 'Lifetime access'],
    durationInMonths: 0,
    isActive: false,
    sortOrder: 202,
    maxContextSizeBytes: 10737418240, // 10 GB
    modelTier: 'premium',
  },
];

// Startup validation
if (PLANS.length !== EXPECTED_PLAN_COUNT) {
  throw new Error(
    `Plan count mismatch: EXPECTED_PLAN_COUNT is ${EXPECTED_PLAN_COUNT} but PLANS array has ${PLANS.length} entries. ` +
      `If you added or removed a plan intentionally, update EXPECTED_PLAN_COUNT to match.`,
  );
}

// Build lookup maps for fast access
const plansByName: Record<string, PlanConfig> = {};
for (const plan of PLANS) {
  plansByName[plan.name] = plan;
}

/** Get all plans */
export const getSubscriptionPlans = (): Record<string, PlanConfig> => plansByName;

/** Get a plan by name, returns null if not found */
export const getSubscriptionPlan = (planName: string): PlanConfig | null => plansByName[planName] || null;

/** Get all active plans (for display to users) */
export const getActiveSubscriptionPlans = (): PlanConfig[] =>
  PLANS.filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder);

/** Get all AppSumo tier plans, sorted ascending. */
export const getAppSumoPlans = (): PlanConfig[] =>
  PLANS.filter((p) => p.name.startsWith('APPSUMO_')).sort((a, b) => a.sortOrder - b.sortOrder);

/** Get a plan by its Stripe price ID, returns null if not found */
export const getSubscriptionPlanByStripePriceId = (priceId: string): PlanConfig | null =>
  PLANS.find((p) => p.stripePriceId === priceId) || null;
