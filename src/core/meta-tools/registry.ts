import type { MetaToolDefinition } from './types.js';

export type MetaToolRegistration = Omit<
  MetaToolDefinition,
  'version' | 'createdAt' | 'updatedAt'
>;

/** In-memory, append-only store of versioned meta-tool definitions. */
export class MetaToolRegistry {
  private readonly toolsById = new Map<string, MetaToolDefinition[]>();

  register(tool: MetaToolRegistration): MetaToolDefinition {
    const versions = this.toolsById.get(tool.id) ?? [];
    const now = new Date().toISOString();
    const definition: MetaToolDefinition = {
      ...tool,
      version: versions.length + 1,
      createdAt: now,
      updatedAt: now,
    };

    versions.push(definition);
    this.toolsById.set(tool.id, versions);
    return { ...definition };
  }

  getLatest(id: string): MetaToolDefinition | undefined {
    const versions = this.toolsById.get(id);
    const latest = versions?.[versions.length - 1];
    return latest ? { ...latest } : undefined;
  }

  getVersion(id: string, version: number): MetaToolDefinition | undefined {
    const definition = this.toolsById.get(id)?.find((tool) => tool.version === version);
    return definition ? { ...definition } : undefined;
  }

  listLatest(): MetaToolDefinition[] {
    return [...this.toolsById.values()]
      .map((versions) => versions[versions.length - 1])
      .filter((tool): tool is MetaToolDefinition => tool !== undefined)
      .map((tool) => ({ ...tool }));
  }
}
