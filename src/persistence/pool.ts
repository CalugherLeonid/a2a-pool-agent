/**
 * Postgres connection pool.
 *
 * A single shared pool for the whole process. All modules that need
 * database access import `query` from here.
 *
 * The pool is created lazily; the first query triggers initialization.
 */

import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('db');

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      // SSL is driven by ?sslmode=verify-full in DATABASE_URL
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on('error', (err) => {
      log.error({ err }, 'unexpected idle client error');
    });

    log.debug('pool created');
  }
  return pool;
}

/** Run a query. Automatically acquires and releases a client. */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<R>> {
  const p = getPool();
  return p.query<R>(text, params as unknown[]);
}

/** Run multiple statements in a single transaction. */
export async function withTransaction<T>(
  fn: (client: {
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ) => Promise<QueryResult<R>>;
  }) => Promise<T>,
): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn({
      query: <R extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: unknown[],
      ) => client.query<R>(text, params as unknown[]),
    });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Graceful shutdown. Called on process exit. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    log.debug('pool closed');
  }
}
