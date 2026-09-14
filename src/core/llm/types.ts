/**
 * Shared types for LLM providers.
 *
 * Both Gemini and Groq expose an OpenAI-compatible chat completions
 * endpoint, so the request/response shapes are the same.
 */

import type { LlmProvider } from '../types/index.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LlmCallResult {
  text: string;
  model: string;
  provider: LlmProvider;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: LlmProvider,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
