/**
 * Adapter registry.
 *
 * Discovers adapter configs from `config/adapters/*.json`, matches them
 * against registered factories, instantiates the adapters, and initializes
 * them. Agent Core interacts with the registry to get adapters - never
 * with concrete classes.
 *
 * Factories are registered explicitly (see `src/index.ts`) to keep the
 * registry decoupled from concrete adapter implementations.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MarketplaceAdapter } from '../adapters/adapter.js';
import type { AdapterConfig, AdapterHealth } from './types/index.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('registry');

const AdapterConfigSchema: z.ZodType<AdapterConfig> = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  credentialsSource: z.enum(['env', 'file', 'inline']),
  priority: z.number().int(),
  credentials: z.union([
    z.object({ source: z.literal('env'), prefix: z.string() }),
    z.object({ source: z.literal('file'), path: z.string() }),
    z.record(z.unknown()),
  ]),
});

export type AdapterFactory = (config: AdapterConfig) => MarketplaceAdapter;

export interface LoadConfigsOptions {
  configDir?: string;
}

export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly configs = new Map<string, AdapterConfig>();
  private readonly instances = new Map<string, MarketplaceAdapter>();

  /** Register a factory for a given adapter id. Chainable. */
  registerFactory(id: string, factory: AdapterFactory): this {
    if (this.factories.has(id)) {
      log.warn({ id }, 'factory already registered, overwriting');
    }
    this.factories.set(id, factory);
    return this;
  }

  /** Load adapter configs from a directory. Chainable. */
  async loadConfigs(options: LoadConfigsOptions = {}): Promise<this> {
    const configDir = options.configDir ?? 'config/adapters';

    let files: string[];
    try {
      files = await readdir(configDir);
    } catch (err) {
      log.warn(
        { configDir, err },
        'config directory not found, no adapters loaded',
      );
      return this;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(configDir, file);

      try {
        const raw = await readFile(path, 'utf-8');
        const parsed = AdapterConfigSchema.parse(JSON.parse(raw));

        if (!parsed.enabled) {
          log.debug({ id: parsed.id, file }, 'adapter disabled, skipping');
          continue;
        }

        this.configs.set(parsed.id, parsed);

        const factory = this.factories.get(parsed.id);
        if (!factory) {
          log.warn({ id: parsed.id, file }, 'no factory registered, skipping');
          continue;
        }

        const instance = factory(parsed);
        this.instances.set(parsed.id, instance);
        log.info(
          { id: parsed.id, priority: parsed.priority },
          'adapter registered',
        );
      } catch (err) {
        log.error({ file, err }, 'failed to load adapter config, skipping');
      }
    }

    return this;
  }

  /** Initialize all loaded adapters. Failures are logged, not fatal. */
  async initAll(): Promise<void> {
    const entries = [...this.instances.entries()].sort((a, b) => {
      const pa = this.configs.get(a[0])?.priority ?? 0;
      const pb = this.configs.get(b[0])?.priority ?? 0;
      return pa - pb;
    });

    for (const [id, adapter] of entries) {
      const config = this.configs.get(id);
      if (!config) continue;
      try {
        await adapter.init(config.credentials);
        log.info({ id }, 'adapter initialized');
      } catch (err) {
        log.error({ id, err }, 'adapter init failed, removing');
        this.instances.delete(id);
      }
    }
  }

  /** Stop all adapters gracefully. */
  async stopAll(): Promise<void> {
    const stops = [...this.instances.values()].map(async (adapter) => {
      try {
        await adapter.stop();
      } catch (err) {
        log.error({ id: adapter.id, err }, 'adapter stop failed');
      }
    });
    await Promise.all(stops);
  }

  /** Get an adapter by id. Throws if not found. */
  get(id: string): MarketplaceAdapter {
    const adapter = this.instances.get(id);
    if (!adapter) {
      throw new Error('Adapter not found: ' + id);
    }
    return adapter;
  }

  /** Get an adapter by id, or undefined if not present. */
  tryGet(id: string): MarketplaceAdapter | undefined {
    return this.instances.get(id);
  }

  /** All active adapters. */
  all(): MarketplaceAdapter[] {
    return [...this.instances.values()];
  }

  /** Ids of all active adapters. */
  ids(): string[] {
    return [...this.instances.keys()];
  }

  /** Health snapshot for all adapters, for observability. */
  health(): AdapterHealth[] {
    return this.all().map((a) => a.health());
  }
}
