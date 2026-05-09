// ============================================================================
// Model Tier Configuration
// Maps AI models to tiers (base/premium) and plans to their allowed tier.
// Used by the model access middleware to enforce plan-based model restrictions.
// ============================================================================

export type ModelTier = 'base' | 'premium';
// User-facing intent grouping — drives the picker UX so users can scan by
// "what do I want" (fast vs. balanced vs. most capable) instead of by
// provider or credit cost.
export type SpeedTier = 'fast' | 'balanced' | 'capable';

export interface ModelConfig {
  key: string; // Model key used in API requests (matches AI service model keys)
  displayName: string;
  description: string;
  provider: string;
  tier: ModelTier;
  creditMultiplier: number; // 1x, 2x, 3x or 5x credit cost
  // Intent grouping for the model picker. Roughly correlates with
  // creditMultiplier today (1x → fast, 2x → balanced, 3x+ → capable) but kept
  // explicit so we can override per-model without changing pricing.
  speedTier: SpeedTier;
  // True if this model should appear in the picker's default view. The full
  // catalog is still queryable via "Show all" — featured = curated short list.
  featured: boolean;
}

// All available models grouped by tier and credit multiplier.
//
// Credit multiplier determines how many credits a query costs:
//   1x = standard cost    (< $0.002/query to us)
//   2x = double cost      ($0.002 – $0.008/query)
//   3x = triple cost      (> $0.008/query)
//
// Tier determines plan access:
//   base    = all plans (FREE, PLUS, PRO, AppSumo T1/T2/T3)
//   premium = PRO + AppSumo T3 only
const MODELS: ModelConfig[] = [
  // =====================
  // BASE — 1x credit (cheapest models, < $0.002/query)
  // Available to all plans → speedTier: 'fast'
  // =====================

  // Amazon Nova (AWS Bedrock)
  {
    key: 'nova-micro',
    displayName: 'Nova Micro',
    description: 'Ultra-fast, lowest latency',
    provider: 'Amazon',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },
  {
    key: 'nova-lite',
    displayName: 'Nova Lite',
    description: 'Cost-effective for simple tasks',
    provider: 'Amazon',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },
  {
    key: 'nova-pro',
    displayName: 'Nova Pro',
    description: 'Balanced speed and capability',
    provider: 'Amazon',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },
  {
    key: 'nova-2-lite',
    displayName: 'Nova 2 Lite',
    description: 'Next-gen reasoning, fast',
    provider: 'Amazon',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },

  // Google Gemini (Direct API)
  {
    key: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    description: 'Fast & efficient for everyday tasks',
    provider: 'Google',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: true, // FREE-plan default + featured choice
  },

  // Mistral (AWS Bedrock)
  {
    key: 'ministral-8b',
    displayName: 'Ministral 8B',
    description: 'Small & efficient',
    provider: 'Mistral',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },
  {
    key: 'magistral-small',
    displayName: 'Magistral Small',
    description: 'Reasoning-focused',
    provider: 'Mistral',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },

  // Qwen (AWS Bedrock)
  {
    key: 'qwen3-32b',
    displayName: 'Qwen3 32B',
    description: 'Strong dense model from Alibaba',
    provider: 'Qwen',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },
  // Note: Qwen3 235B removed — not available in us-east-1 region

  // OpenAI OSS (AWS Bedrock)
  {
    key: 'gpt-oss-120b',
    displayName: 'GPT-OSS 120B',
    description: 'Large reasoning model (120B)',
    provider: 'OpenAI',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: true, // Best 1x alternative for users wanting OpenAI-style reasoning
  },

  // MiniMax (AWS Bedrock)
  {
    key: 'minimax-m2',
    displayName: 'MiniMax M2.1',
    description: 'General-purpose model',
    provider: 'MiniMax',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },

  // Z.AI / Zhipu (AWS Bedrock)
  {
    key: 'glm-4.7',
    displayName: 'GLM 4.7',
    description: 'Multilingual model from Zhipu',
    provider: 'ZAI',
    tier: 'base',
    creditMultiplier: 1,
    speedTier: 'fast',
    featured: false,
  },

  // =====================
  // BASE — 2x credits (mid-range models, $0.002 – $0.008/query)
  // Available to all plans, costs double credits → speedTier: 'balanced'
  // =====================

  // Moonshot AI (AWS Bedrock)
  {
    key: 'kimi-k2.5',
    displayName: 'Kimi K2.5',
    description: 'Strong reasoning from Moonshot',
    provider: 'Moonshot',
    tier: 'base',
    creditMultiplier: 2,
    speedTier: 'balanced',
    featured: false,
  },

  // Writer (AWS Bedrock)
  {
    key: 'palmyra-x5',
    displayName: 'Palmyra X5',
    description: 'Advanced enterprise writing',
    provider: 'Writer',
    tier: 'base',
    creditMultiplier: 2,
    speedTier: 'balanced',
    featured: false,
  },
  {
    key: 'palmyra-x4',
    displayName: 'Palmyra X4',
    description: 'Enterprise writing model',
    provider: 'Writer',
    tier: 'base',
    creditMultiplier: 2,
    speedTier: 'balanced',
    featured: false,
  },

  // Anthropic Claude (AWS Bedrock)
  {
    key: 'claude-haiku-4.5',
    displayName: 'Claude Haiku 4.5',
    description: 'Fast, great for quick answers',
    provider: 'Anthropic',
    tier: 'base',
    creditMultiplier: 2,
    speedTier: 'balanced',
    featured: true, // PLUS-plan default + best base-tier instruction following
  },

  // DeepSeek (AWS Bedrock)
  {
    key: 'deepseek-r1',
    displayName: 'DeepSeek R1',
    description: 'Advanced chain-of-thought reasoning',
    provider: 'DeepSeek',
    tier: 'base',
    creditMultiplier: 2,
    speedTier: 'balanced',
    featured: true,
  },

  // Google Gemini (Direct API)
  {
    key: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    description: 'Advanced reasoning & analysis',
    provider: 'Google',
    tier: 'base',
    creditMultiplier: 2,
    speedTier: 'balanced',
    featured: false, // superseded by gemini-3.1-pro
  },
  {
    key: 'gemini-3.1-pro',
    displayName: 'Gemini 3.1 Pro',
    description: 'Latest thinking model from Google',
    provider: 'Google',
    tier: 'base',
    creditMultiplier: 2,
    speedTier: 'balanced',
    featured: true,
  },

  // Note: Meta Llama models removed — geo-restricted (blocked in certain countries per Meta EULA)

  // =====================
  // PREMIUM — 3x credits (most expensive models, > $0.008/query)
  // Available to PRO + AppSumo T3 only → speedTier: 'capable'
  // =====================

  // Mistral (AWS Bedrock)
  {
    key: 'mistral-large-3',
    displayName: 'Mistral Large 3',
    description: 'Powerful 675B parameter model',
    provider: 'Mistral',
    tier: 'premium',
    creditMultiplier: 3,
    speedTier: 'capable',
    featured: false,
  },

  // Anthropic Claude (AWS Bedrock)
  {
    key: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    description: 'Strong balanced model',
    provider: 'Anthropic',
    tier: 'premium',
    creditMultiplier: 3,
    speedTier: 'capable',
    featured: false, // superseded by claude-sonnet-4.5
  },
  {
    key: 'claude-sonnet-4.5',
    displayName: 'Claude Sonnet 4.5',
    description: 'Best for coding & agents',
    provider: 'Anthropic',
    tier: 'premium',
    creditMultiplier: 3,
    speedTier: 'capable',
    featured: true, // PRO-plan default + top user-preference for chat
  },
  {
    key: 'claude-opus-4.5',
    displayName: 'Claude Opus 4.5',
    description: 'Most capable Claude model',
    provider: 'Anthropic',
    tier: 'premium',
    creditMultiplier: 5,
    speedTier: 'capable',
    featured: true,
  },
  {
    key: 'claude-opus-4.1',
    displayName: 'Claude Opus 4.1',
    description: 'Advanced complex reasoning',
    provider: 'Anthropic',
    tier: 'premium',
    creditMultiplier: 5,
    speedTier: 'capable',
    featured: false, // superseded by claude-opus-4.5
  },
  // Note: Claude Opus 4.6 + Sonnet 4.6 removed — require inference profile, on-demand not supported
];

// Build lookup maps
const modelsByKey: Record<string, ModelConfig> = {};
for (const model of MODELS) {
  modelsByKey[model.key] = model;
}

// Aliases: shorthand keys that resolve to a canonical model
const MODEL_ALIASES: Record<string, string> = {
  gemini: 'gemini-2.5-flash',
};

/** Resolve a model key, following aliases if needed */
const resolveModelKey = (modelKey: string): string => MODEL_ALIASES[modelKey] || modelKey;

/** Get model config by key, returns null if not found */
export const getModelConfig = (modelKey: string): ModelConfig | null => modelsByKey[resolveModelKey(modelKey)] || null;

/** Get the tier of a model (defaults to 'premium' for unknown models as a safety measure) */
export const getModelTier = (modelKey: string): ModelTier => modelsByKey[resolveModelKey(modelKey)]?.tier || 'premium';

/** Get all models available for a given tier */
export const getModelsForTier = (tier: ModelTier): ModelConfig[] => {
  if (tier === 'premium') return MODELS; // Premium gets all models
  return MODELS.filter((m) => m.tier === 'base');
};

/** Check if a model key is allowed for a given tier */
export const isModelAllowedForTier = (modelKey: string, planTier: ModelTier): boolean => {
  if (planTier === 'premium') return true; // Premium tier can access all models
  const resolved = resolveModelKey(modelKey);
  const model = modelsByKey[resolved];
  if (!model) return false; // Unknown models are blocked
  return model.tier === 'base';
};

/** Get the credit multiplier for a model (defaults to 1 for unknown models) */
export const getCreditMultiplier = (modelKey: string): number =>
  modelsByKey[resolveModelKey(modelKey)]?.creditMultiplier || 1;

/** Get all models as a list */
export const getAllModels = (): ModelConfig[] => [...MODELS];

// ============================================================================
// Per-plan default model
// ----------------------------------------------------------------------------
// First-time users (and users whose preferredModel was cleared / is no longer
// available) get this model as their starting point. Plans pay for better
// defaults — FREE runs the cheapest reliable model, PLUS gets a higher-quality
// base-tier model, PRO unlocks the premium-tier flagship.
// ============================================================================
const FALLBACK_DEFAULT = 'gemini-2.5-flash';

const PLAN_DEFAULTS: Record<string, string> = {
  FREE: 'gemini-2.5-flash',
  PLUS_MONTHLY: 'claude-haiku-4.5',
  PLUS_YEARLY: 'claude-haiku-4.5',
  APPSUMO_TIER_1: 'claude-haiku-4.5',
  APPSUMO_TIER_2: 'claude-haiku-4.5',
  PRO_MONTHLY: 'claude-sonnet-4.5',
  PRO_YEARLY: 'claude-sonnet-4.5',
  APPSUMO_TIER_3: 'claude-sonnet-4.5',
};

/**
 * Get the default model key for a given plan type. Falls back to the global
 * default if the plan has no explicit mapping (e.g. a new plan added without
 * updating PLAN_DEFAULTS) or if the mapped model is no longer in the catalog
 * (e.g. removed for region/Bedrock issues — see the removal notes above).
 */
export const getDefaultModelForPlan = (planType: string): string => {
  const candidate = PLAN_DEFAULTS[planType] || FALLBACK_DEFAULT;
  // Verify the candidate still exists in the catalog. If a default was
  // removed (e.g. Llama geo-blocked, Sonnet 4.6 inference-profile-only), fall
  // back so we never hand the client a key it can't actually use.
  if (modelsByKey[candidate]) return candidate;
  return modelsByKey[FALLBACK_DEFAULT] ? FALLBACK_DEFAULT : MODELS[0].key;
};
