/**
 * Groq provider via its OpenAI-compatible endpoint.
 *
 * Docs: https://console.groq.com/docs/openai
 */

import type { ChatMessage, LlmCallResult } from './types.js';
import { callOpenAiCompatible } from './client.js';

const BASE_URL = 'https://api.groq.com/openai/v1';

export interface GroqConfig {
  apiKey: string;
  model: string;
}

export async function callGroq(
  config: GroqConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number; jsonMode?: boolean } = {},
): Promise<LlmCallResult> {
  return callOpenAiCompatible(
    {
      provider: 'groq',
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
