/**
 * Quality check.
 *
 * Validates the executor output against the task's declared JSON
 * Schema and produces a decision:
 *
 *   - deliver: output is valid, ship it
 *   - retry:   output is invalid but retryable (schema mismatch, etc.)
 *   - fail:    output is not retryable (empty, unparseable)
 *
 * The validator is a minimal JSON Schema subset sufficient for the
 * task types we handle. It supports:
 *
 *   type: object | array | string | number | integer | boolean | null
 *   properties, required, items, enum
 *
 * Anything more elaborate is out of scope for V1. If a task demands
 * a richer schema, the caller is expected to reject it during triage.
 */

import type { JsonSchema, QualityReport, QualityScore } from './types/index.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('quality');

export interface ValidationError {
  path: string;
  message: string;
}

// ─── Minimal JSON Schema validator ─────────────────────────────

function validate(
  value: unknown,
  schema: JsonSchema,
  path = '$',
): ValidationError[] {
  const errors: ValidationError[] = [];

  // type check
  if (schema.type) {
    if (!matchesType(value, schema.type)) {
      errors.push({
        path,
        message:
          'expected ' + schema.type + ', got ' + describeType(value),
      });
      return errors; // no point checking further
    }
  }

  // enum check
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({
      path,
      message: 'value not in enum [' + schema.enum.join(', ') + ']',
    });
  }

  // object checks
  if (schema.type === 'object' && isPlainObject(value)) {
    const obj = value as Record<string, unknown>;

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({ path: path + '.' + key, message: 'required' });
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          errors.push(
            ...validate(obj[key], propSchema, path + '.' + key),
          );
        }
      }
    }
  }

  // array checks
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validate(item, schema.items!, path + '[' + i + ']'));
      });
    }
  }

  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // unknown type: don't fail
  }
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ─── QualityChecker ────────────────────────────────────────────

export interface QualityCheckInput {
  output: unknown;
  schema: JsonSchema;
  /** Number of prior attempts, used to decide retry vs fail. */
  attempt: number;
  /** Max retries allowed for this task. */
  maxRetries: number;
}

export class QualityChecker {
  check(input: QualityCheckInput): QualityReport {
    const { output, schema, attempt, maxRetries } = input;

    // --- Empty output ---
    if (output === undefined || output === null) {
      return {
        score: 0,
        schemaValid: false,
        hallucinationFlags: [],
        decision: attempt < maxRetries ? 'retry' : 'fail',
        reason: 'empty_output',
      };
    }

    // --- Schema validation ---
    const errors = validate(output, schema);
    const schemaValid = errors.length === 0;

    if (!schemaValid) {
      const reason =
        'schema_invalid:' +
        errors
          .slice(0, 3)
          .map((e) => e.path + ' ' + e.message)
          .join('; ');

      const decision = attempt < maxRetries ? 'retry' : 'fail';

      log.debug(
        { attempt, maxRetries, errors: errors.slice(0, 3), decision },
        'schema invalid',
      );

      return {
        score: computeScore(errors.length),
        schemaValid: false,
        hallucinationFlags: [],
        decision,
        reason,
      };
    }

    // --- Valid output ---
    return {
      score: 1,
      schemaValid: true,
      hallucinationFlags: [],
      decision: 'deliver',
      reason: 'schema_valid',
    };
  }
}

function computeScore(errorCount: number): QualityScore {
  // Simple heuristic: 1 error -> 0.7, 2 -> 0.5, 3+ -> 0.3
  if (errorCount === 0) return 1;
  if (errorCount === 1) return 0.7;
  if (errorCount === 2) return 0.5;
  return 0.3;
}
