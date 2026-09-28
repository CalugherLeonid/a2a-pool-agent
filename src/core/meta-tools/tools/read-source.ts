import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { MetaToolRegistry } from '../registry.js';
import type { MetaToolDefinition } from '../types.js';

export interface ReadSourceInput {
  /** If provided, attempts to read from registry by toolId */
  toolId?: string;
  version?: number;
  /** If provided, reads from permitted local filesystem paths */
  path?: string;
}

export interface ReadSourceOutput {
  success: boolean;
  tool?: MetaToolDefinition;
  sourceCode?: string;
  path?: string;
  error?: string;
}

/**
 * Meta-Tool for reading source code safely.
 * Only permitted paths (e.g. src/tools, src/core/meta-tools, src/adapters) can be read.
 * Sensitive paths (such as .env, keys, root etc.) are strictly forbidden.
 */
export class ReadSourceTool {
  private static readonly ALLOWED_PREFIXES = [
    'src/tools',
    'src/core/meta-tools',
    'src/core',
    'src/adapters',
  ];

  constructor(private readonly registry?: MetaToolRegistry) {}

  execute(input: ReadSourceInput): ReadSourceOutput {
    // 1. Tool-based lookup if toolId is supplied
    if (input.toolId) {
      if (!this.registry) {
        return {
          success: false,
          error: 'MetaToolRegistry is not configured for toolId lookup.',
        };
      }

      const tool =
        input.version === undefined
          ? this.registry.getLatest(input.toolId)
          : this.registry.getVersion(input.toolId, input.version);

      if (tool) {
        return {
          success: true,
          tool,
          sourceCode: tool.sourceCode,
          path: `registry://${tool.id}/v${tool.version}`,
        };
      }

      const versionSuffix =
        input.version === undefined
          ? 'latest version'
          : `version ${input.version}`;
      return {
        success: false,
        error: `Meta-tool '${input.toolId}' (${versionSuffix}) was not found.`,
      };
    }

    // 2. Path-based lookup
    if (input.path) {
      return this.readFromFilesystem(input.path);
    }

    return {
      success: false,
      error: 'Either toolId or path must be specified to read_source.',
    };
  }

  private readFromFilesystem(targetPath: string): ReadSourceOutput {
    const cwd = process.cwd();
    const cleanPath = targetPath.trim();

    // Prevent direct sensitive files
    if (
      cleanPath.includes('.env') ||
      cleanPath.includes('id_ed25519') ||
      cleanPath.includes('.key') ||
      cleanPath.includes('.pem')
    ) {
      return {
        success: false,
        error: `Access to sensitive path forbidden: ${targetPath}`,
      };
    }

    const resolved = isAbsolute(cleanPath)
      ? normalize(cleanPath)
      : resolve(cwd, cleanPath);

    const rel = relative(cwd, resolved).replace(/\\/g, '/');

    // Prevent traversal out of workspace
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        success: false,
        error: `Path traversal outside project root is forbidden: ${targetPath}`,
      };
    }

    // Check against allowed prefixes
    const isAllowed = ReadSourceTool.ALLOWED_PREFIXES.some(
      (prefix) => rel === prefix || rel.startsWith(`${prefix}/`),
    );

    if (!isAllowed) {
      return {
        success: false,
        error: `Path '${targetPath}' is outside permitted source directories (${ReadSourceTool.ALLOWED_PREFIXES.join(
          ', ',
        )}).`,
      };
    }

    if (!existsSync(resolved)) {
      return {
        success: false,
        error: `File not found: ${targetPath}`,
      };
    }

    try {
      const sourceCode = readFileSync(resolved, 'utf8');
      return {
        success: true,
        sourceCode,
        path: rel,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to read file ${targetPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
}
