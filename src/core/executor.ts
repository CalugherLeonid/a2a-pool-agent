/**
 * Executor.
 *
 * Given a task, produces a structured output by calling an LLM with
 * fallback between providers: Gemini first, Groq second, OpenRouter third.
 *
 * The model passed via input.model (from the router) overrides the
 * provider's configured model when present.
 */

import type { RawTask } from './types/index.js';
import type { LlmProvider } from './types/index.js';
import type { ChatMessage, LlmCallResult } from './llm/types.js';
import { callGemini, type GeminiConfig } from './llm/gemini.js';
import { callGroq, type GroqConfig } from './llm/groq.js';
import { callOpenRouter, type OpenRouterConfig } from './llm/openrouter.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('executor');

export interface ExecutionInput {
  task: RawTask;
  model?: string;
  maxTokens?: number;
  attempt?: number;
  previousError?: string;
}

export interface ExecutionResult {
  output: unknown;
  model: string;
  provider: LlmProvider;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  finishReason: string;
}

export interface Executor {
  execute(input: ExecutionInput): Promise<ExecutionResult>;
}

export interface LlmExecutorDeps {
  gemini?: GeminiConfig;
  groq?: GroqConfig;
  openrouter?: OpenRouterConfig;
}

function buildMessages(task: RawTask, input: ExecutionInput): ChatMessage[] {
  const strict = (input.attempt ?? 0) > 0;

  const systemPrompt = strict
    ? [
        'You are an autonomous A2A pool worker agent.',
        'Previous attempt failed schema validation.',
        'Respond with ONLY a single, valid JSON object.',
        'Start with { and end with }. No prose, no markdown, no fences.',
        'Every required field in the schema MUST be present.',
      ].join(' ')
    : [
        'You are an autonomous A2A pool worker agent.',
        'Execute the user task and respond with ONLY a single JSON object.',
        'Do not include prose, markdown, or code fences.',
        'Do not explain. Return the JSON object and nothing else.',
      ].join(' ');

  const userParts: string[] = [];
  userParts.push('Task type: ' + task.type);
  userParts.push('Instruction: ' + task.prompt);
  if (task.input !== undefined) {
    userParts.push('Input: ' + JSON.stringify(task.input));
  }
  userParts.push('Output JSON schema: ' + JSON.stringify(task.outputSchema));

  if (strict && input.previousError) {
    userParts.push('Previous attempt failed with: ' + input.previousError);
    userParts.push(
      'Pay close attention to required fields and their types. ' +
        'Return the corrected JSON object only.',
    );
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error('Could not extract JSON from LLM output');
}

function estimateCost(
  provider: LlmProvider,
  tokensIn: number,
  tokensOut: number,
): number {
  const rates: Record<LlmProvider, { in: number; out: number }> = {
    google: { in: 0.075, out: 0.30 },
    groq: { in: 0.59, out: 0.79 },
    openrouter: { in: 0, out: 0 },
    deepseek: { in: 0.14, out: 0.28 },
    anthropic: { in: 3.0, out: 15.0 },
  };
  const r = rates[provider];
  return (tokensIn / 1_000_000) * r.in + (tokensOut / 1_000_000) * r.out;
}

export class LlmExecutor implements Executor {
  constructor(private readonly deps: LlmExecutorDeps) {
    if (!deps.gemini && !deps.groq && !deps.openrouter) {
      throw new Error('LlmExecutor requires at least one provider');
    }
  }

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    const messages = buildMessages(input.task, input);
    const maxTokens = input.maxTokens ?? 1024;

    const providers: Array<{
      name: string;
      call: () => Promise<LlmCallResult>;
    }> = [];

    if (this.deps.gemini) {
      const gemini = this.deps.gemini;
      const model = input.model ?? gemini.model;
      providers.push({
        name: 'gemini',
        call: () =>
          callGemini(
            { apiKey: gemini.apiKey, model },
            messages,
            { maxTokens, jsonMode: true },
          ),
      });
    }

    if (this.deps.groq) {
      const groq = this.deps.groq;
      providers.push({
        name: 'groq',
        call: () => callGroq(groq, messages, { maxTokens, jsonMode: true }),
      });
    }

    if (this.deps.openrouter) {
      const openrouter = this.deps.openrouter;
      providers.push({
        name: 'openrouter',
        call: () =>
          callOpenRouter(openrouter, messages, { maxTokens, jsonMode: true }),
      });
    }

    let lastError: unknown;
    for (const provider of providers) {
      const startedAt = Date.now();
      try {
        const result = await provider.call();
        const latencyMs = Date.now() - startedAt;

        const output = parseJsonFromText(result.text);
        const costUsd = estimateCost(
          result.provider,
          result.tokensIn,
          result.tokensOut,
        );

        log.info(
          {
            provider: result.provider,
            model: result.model,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            latencyMs,
            costUsd,
            attempt: input.attempt ?? 0,
          },
          'executed',
        );

        return {
          output,
          model: result.model,
          provider: result.provider,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsd,
          latencyMs,
          finishReason: result.finishReason,
        };
      } catch (err) {
        lastError = err;
        log.warn(
          { provider: provider.name, err },
          'provider failed, trying next',
        );
      }
    }

    throw new Error(
      'All LLM providers failed: ' +
        (lastError instanceof Error ? lastError.message : String(lastError)),
    );
  }
}
