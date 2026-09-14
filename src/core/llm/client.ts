/**
 * Low-level OpenAI-compatible chat completions client.
 *
 * Both Gemini (via its OpenAI-compatible endpoint) and Groq use the
 * same request/response format, so we share the transport.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmCallResult,
} from './types.js';
import { LlmError } from './types.js';
import type { LlmProvider } from '../types/index.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface OpenAiCompatibleConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export async function callOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  body: ChatCompletionRequest,
): Promise<LlmCallResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const res = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(
        config.provider + ' HTTP ' + res.status + ': ' + (text || res.statusText),
        config.provider,
        res.status,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new LlmError(
        config.provider + ' returned no choices',
        config.provider,
      );
    }

    return {
      text: choice.message.content ?? '',
      model: data.model ?? body.model,
      provider: config.provider,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
      finishReason: choice.finish_reason ?? 'unknown',
    };
  } finally {
    clearTimeout(timer);
  }
}
