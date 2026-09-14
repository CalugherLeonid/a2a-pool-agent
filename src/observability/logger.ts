/**
 * Structured logger. Pino in production (JSON), pino-pretty in development.
 *
 * Usage:
 *   const log = createLogger('triage');
 *   log.info({ taskId, decision }, 'accepted');
 */

import pino, { type Logger } from 'pino';
import { env } from '../config/env.js';

export type { Logger } from 'pino';

const isDev = env.NODE_ENV === 'development';

const root: Logger = pino({
  level: env.LOG_LEVEL,
  base: { agent: env.AGENT_NAME },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,agent',
          },
        },
      }
    : {}),
});

export function createLogger(module: string): Logger {
  return root.child({ module });
}

export const logger: Logger = root;
