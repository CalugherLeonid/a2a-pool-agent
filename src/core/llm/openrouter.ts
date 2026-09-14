/**
 * OpenRouter provider.
 *
 * OpenRouter is an OpenAI-compatible router that provides access to
 * hundreds of models through a single endpoint, including a curated
 * selection of permanently free models via the `openrouter/free` route.
 *
 * Docs: https://openrouter.ai/docs
 * Free models: https://openrouter.ai/models?max_price=0
 *
 * Rate limits (no credit): 50 requests/day
 * Rate limits (with $10 credit): 1000 requests/day
 */

import type { ChatMessage, LlmCallResult } from './types.js';
import { callOpenAiCompatible } from './client.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
}

export async function callOpenRouter(
  config: OpenRouterConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number; jsonMode?: boolean } = {},
): Promise<LlmCallResult> {
  return callOpenAiCompatible(
    {
      provider: 'openrouter',
      baseUrl: BASE_URL,
      apiKey: config.apiKey,
    },
    {
      model: config.model,
      messages,
      temperature: 0.1,
      max_tokens: options.maxTokens ?? 1024,
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
  );
}
