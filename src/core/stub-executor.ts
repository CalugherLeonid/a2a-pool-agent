/**
 * Stub executor used when no LLM provider is configured.
 *
 * Returns a deterministic placeholder output so the full Agent Core
 * loop can be exercised without external dependencies. This is what
 * gets used when neither GEMINI_API_KEY nor GROQ_API_KEY is set.
 */

import type {
  ExecutionInput,
  ExecutionResult,
  Executor,
} from './executor.js';

export class StubExecutor implements Executor {
  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, 20));

    // Build a plausible output for the mock templates. Because the mock
    // task generator uses well-known schemas, we can produce a valid
    // shape that passes the quality checker without an LLM.
    const output = buildStubOutput(input);

    return {
      output,
      model: 'stub-model',
      provider: 'groq',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      finishReason: 'stub',
    };
  }
}

function buildStubOutput(input: ExecutionInput): unknown {
  const task = input.task;
  const type = task.type;

  if (type === 'extract') return { dates: ['2026-05-12'] };
  if (type === 'summarize')
    return { summary: ['Stub summary.', 'Stub point two.', 'Stub point three.'] };
  if (type === 'classify') return { label: 'neutral' };
  if (type === 'transform') return { row: { id: '1001', name: 'Acme', amount: 1240 } };

  return {
    stub: true,
    taskType: type,
    echo: task.prompt.slice(0, 80),
    processedAt: new Date().toISOString(),
  };
}
