/**
 * Deterministic task generator for the mock adapter.
 *
 * Rotates through a small pool of templates so that each poll cycle
 * produces a varied, realistic-looking task. No randomness is used,
 * which keeps logs and learning events reproducible.
 */

import type { JsonSchema, RawTask } from '../../core/types/index.js';

interface Template {
  type: string;
  prompt: string;
  budgetEstimateUsd: number;
  deadlineS: number;
  outputSchema: JsonSchema;
  input?: unknown;
}

const TEMPLATES: Template[] = [
  {
    type: 'extract',
    prompt:
      'Extract all ISO 8601 dates from the following invoice text and return them as a JSON array under the key "dates".',
    budgetEstimateUsd: 0.45,
    deadlineS: 300,
    outputSchema: {
      type: 'object',
      properties: {
        dates: { type: 'array', items: { type: 'string' } },
      },
      required: ['dates'],
    },
    input:
      'Invoice #4421 issued 2026-05-12, due 2026-06-12, reminder sent 2026-05-30.',
  },
  {
    type: 'summarize',
    prompt:
      'Summarize the following text in 3 bullet points under the key "summary".',
    budgetEstimateUsd: 0.55,
    deadlineS: 300,
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
    },
    input:
      'Agent economies enable autonomous software to negotiate, deliver, and settle work without human intermediaries.',
  },
  {
    type: 'classify',
    prompt:
      'Classify the sentiment of the following text as one of "positive", "neutral", "negative" under the key "label".',
    budgetEstimateUsd: 0.35,
    deadlineS: 180,
    outputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      },
      required: ['label'],
    },
    input: 'The delivery arrived on time and matched the specification exactly.',
  },
  {
    type: 'transform',
    prompt:
      'Convert the following CSV row into a JSON object under the key "row".',
    budgetEstimateUsd: 0.40,
    deadlineS: 240,
    outputSchema: {
      type: 'object',
      properties: {
        row: { type: 'object' },
      },
      required: ['row'],
    },
    input: 'id,name,amount\n1001,Acme Corp,1240.00',
  },
];

export class MockTaskGenerator {
  private counter = 0;

  constructor(
    private readonly opts: {
      taskPoolSize: number;
      idPrefix: string;
    },
  ) {}

  next(): RawTask {
    const idx = this.counter % this.opts.taskPoolSize;
    this.counter += 1;

    const template = TEMPLATES[idx % TEMPLATES.length]!;
    const id = this.opts.idPrefix + '-' + String(this.counter).padStart(4, '0');

    return {
      id,
      source: 'mock',
      type: template.type,
      prompt: template.prompt,
      input: template.input,
      outputSchema: template.outputSchema,
      budgetEstimateUsd: template.budgetEstimateUsd,
      deadlineS: template.deadlineS,
      observedAt: new Date().toISOString(),
      raw: { mock: true, templateIndex: idx },
    };
  }
}
