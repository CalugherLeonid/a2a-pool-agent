/**
 * Token-based LLM Cost Estimator for the A2A Agent Economy.
 *
 * Computes estimated inference cost in USD/USDT based on prompt token count,
 * projected completion tokens, and model pricing tiers.
 */

export interface ModelPricingTier {
  /** Cost per 1,000,000 prompt (input) tokens in USD. */
  inputPricePerMillion: number;
  /** Cost per 1,000,000 completion (output) tokens in USD. */
  outputPricePerMillion: number;
  /** Estimated typical output token length if none specified. */
  defaultOutputTokens: number;
}

/**
 * Standard pricing catalog across supported model providers.
 * USD and USDT are treated as parity (1 USD = 1 USDT).
 */
export const MODEL_PRICING_TABLE: Record<string, ModelPricingTier> = {
  // Google Gemini models
  'gemini-1.5-flash': {
    inputPricePerMillion: 0.075,
    outputPricePerMillion: 0.30,
    defaultOutputTokens: 500,
  },
  'gemini-2.0-flash': {
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.40,
    defaultOutputTokens: 500,
  },
  'gemini-1.5-pro': {
    inputPricePerMillion: 1.25,
    outputPricePerMillion: 5.00,
    defaultOutputTokens: 800,
  },
  'gemini-3.5-flash-lite': {
    inputPricePerMillion: 0.05,
    outputPricePerMillion: 0.20,
    defaultOutputTokens: 400,
  },

  // Groq models
  'llama-3.3-70b-versatile': {
    inputPricePerMillion: 0.59,
    outputPricePerMillion: 0.79,
    defaultOutputTokens: 600,
  },
  'llama-3.1-8b-instant': {
    inputPricePerMillion: 0.05,
    outputPricePerMillion: 0.08,
    defaultOutputTokens: 400,
  },
  'mixtral-8x7b-32768': {
    inputPricePerMillion: 0.24,
    outputPricePerMillion: 0.24,
    defaultOutputTokens: 500,
  },

  // OpenRouter / Other
  'deepseek/deepseek-chat': {
    inputPricePerMillion: 0.14,
    outputPricePerMillion: 0.28,
    defaultOutputTokens: 600,
  },
  'openai/gpt-4o-mini': {
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
    defaultOutputTokens: 500,
  },
};

/** Default conservative pricing tier if model is unrecognized. */
export const DEFAULT_PRICING_TIER: ModelPricingTier = {
  inputPricePerMillion: 0.15,
  outputPricePerMillion: 0.60,
  defaultOutputTokens: 500,
};

export interface TokenCostBreakdown {
  model: string;
  promptTokens: number;
  expectedOutputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

/**
 * Calculates the estimated LLM cost in USD/USDT given prompt token length and model.
 *
 * @param promptTokens Number of tokens in the input prompt.
 * @param model Target model identifier (e.g. "gemini-1.5-flash").
 * @param expectedOutputTokens Optional expected output token count.
 * @returns Estimated cost in USD/USDT.
 */
export function estimateCostByTokens(
  promptTokens: number,
  model: string,
  expectedOutputTokens?: number,
): number {
  const breakdown = getDetailedCostBreakdown(promptTokens, model, expectedOutputTokens);
  return breakdown.totalCostUsd;
}

/**
 * Returns a full cost breakdown including input and output cost components.
 */
export function getDetailedCostBreakdown(
  promptTokens: number,
  model: string,
  expectedOutputTokens?: number,
): TokenCostBreakdown {
  const pricing = MODEL_PRICING_TABLE[model.toLowerCase()] ?? DEFAULT_PRICING_TIER;
  const safePromptTokens = Math.max(0, promptTokens);
  const outTokens = expectedOutputTokens ?? pricing.defaultOutputTokens;

  const inputCost = (safePromptTokens / 1_000_000) * pricing.inputPricePerMillion;
  const outputCost = (outTokens / 1_000_000) * pricing.outputPricePerMillion;
  const totalCost = Number((inputCost + outputCost).toFixed(6));

  return {
    model,
    promptTokens: safePromptTokens,
    expectedOutputTokens: outTokens,
    inputCostUsd: Number(inputCost.toFixed(6)),
    outputCostUsd: Number(outputCost.toFixed(6)),
    totalCostUsd: totalCost,
  };
}

/**
 * Heuristic token counter for text (approximately 4 characters per token in English).
 */
export function countEstimatedTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimates LLM cost directly from raw prompt text and model name.
 */
export function estimateCostFromPromptText(
  prompt: string,
  model: string,
  expectedOutputTokens?: number,
): number {
  const tokens = countEstimatedTokens(prompt);
  return estimateCostByTokens(tokens, model, expectedOutputTokens);
}
