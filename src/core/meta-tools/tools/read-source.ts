import { MetaToolRegistry } from '../registry.js';
import type { MetaToolDefinition } from '../types.js';

export interface ReadSourceInput {
  toolId: string;
  version?: number;
}

export interface ReadSourceOutput {
  success: boolean;
  tool?: MetaToolDefinition;
  error?: string;
}

/** Read-only access to registered meta-tool source definitions. */
export class ReadSourceTool {
  constructor(private readonly registry: MetaToolRegistry) {}

  execute(input: ReadSourceInput): ReadSourceOutput {
    const tool = input.version === undefined
      ? this.registry.getLatest(input.toolId)
      : this.registry.getVersion(input.toolId, input.version);

    if (tool) {
      return { success: true, tool };
    }

    const versionSuffix = input.version === undefined
      ? 'latest version'
      : `version ${input.version}`;
    return {
      success: false,
      error: `Meta-tool '${input.toolId}' (${versionSuffix}) was not found.`,
    };
  }
}
