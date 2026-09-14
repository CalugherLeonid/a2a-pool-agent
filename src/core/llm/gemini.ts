/**
 * Gemini provider via its OpenAI-compatible endpoint.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/openai
 */

import type { ChatMessage, LlmCallResult } from './types.js';
import { callOpenAiCompatible } from './client.js';

const BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai';

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

export async function callGemini(
  config: GeminiConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number; jsonMode?: boolean } = {},
): Promise<LlmCallResult> {
  return callOpenAiCompatible(
    {
      provider: 'google',
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
