import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { MetaToolRegistry } from '../registry.js';
import { SandboxSecurityGuard } from '../../sandbox/security-guard.js';

export interface EditSourceInput {
  /** Path to permitted source file or registered toolId */
  path?: string;
  toolId?: string;
  instruction: string;
  /**
   * Proposed transformed code.
   * In System 2 / LLM workflows, this is the candidate source code generated based on the instruction.
   */
  proposedCode?: string;
  /**
   * Optional simple search-and-replace specification if proposedCode is not provided directly.
   */
  replacement?: {
    search: string;
    replace: string;
  };
}

export interface DiffLine {
  type: 'add' | 'del' | 'same';
  text: string;
}

export interface EditSourceOutput {
  success: boolean;
  target: string;
  originalCode: string;
  proposedCode: string;
  diff: string;
  diffLines: DiffLine[];
  instruction: string;
  securityChecksPassed: boolean;
  securityViolations: string[];
  applied: boolean; // Always false! edit_source never applies changes directly.
  error?: string;
}

/**
 * Meta-Tool for proposing a modification to a source file or registered meta-tool.
 *
 * CRITICAL ZERO-TRUST RULE:
 * This tool NEVER applies or overwrites code directly (`applied: false`).
 * It produces a diff and candidate code, runs initial static security auditing,
 * and leaves evaluation & application strictly to RatchetSystem and HotReloadTool.
 */
export class EditSourceTool {
  private static readonly ALLOWED_PREFIXES = [
    'src/tools',
    'src/core/meta-tools',
    'src/core',
    'src/adapters',
  ];

  constructor(private readonly registry?: MetaToolRegistry) {}

  execute(input: EditSourceInput): EditSourceOutput {
    let originalCode = '';
    let targetIdentifier = '';

    // 1. Resolve source to edit
    if (input.toolId && this.registry) {
      const tool = this.registry.getLatest(input.toolId);
      if (!tool) {
        return this.failureResult(
          input.toolId,
          `Meta-tool '${input.toolId}' was not found in registry.`,
          input.instruction,
        );
      }
      originalCode = tool.sourceCode;
      targetIdentifier = `registry://${tool.id}`;
    } else if (input.path) {
      const pathResolution = this.resolveAndReadFile(input.path);
      if (!pathResolution.success) {
        return this.failureResult(
          input.path,
          pathResolution.error ?? 'Failed to read target path.',
          input.instruction,
        );
      }
      originalCode = pathResolution.sourceCode!;
      targetIdentifier = pathResolution.path!;
    } else {
      return this.failureResult(
        'unknown',
        'Either toolId or path must be specified for edit_source.',
        input.instruction,
      );
    }

    // 2. Derive proposed code
    let proposedCode = '';
    if (typeof input.proposedCode === 'string') {
      proposedCode = input.proposedCode;
    } else if (input.replacement) {
      if (!originalCode.includes(input.replacement.search)) {
        return this.failureResult(
          targetIdentifier,
          `Target substring to replace was not found in ${targetIdentifier}.`,
          input.instruction,
          originalCode,
        );
      }
      proposedCode = originalCode.replace(
        input.replacement.search,
        input.replacement.replace,
      );
    } else {
      return this.failureResult(
        targetIdentifier,
        'Either proposedCode or replacement must be supplied with the edit instruction.',
        input.instruction,
        originalCode,
      );
    }

    // 3. Static Security Guard check
    const audit = SandboxSecurityGuard.auditSourceCode(proposedCode);
    const diffResult = this.computeUnifiedDiff(originalCode, proposedCode);

    return {
      success: audit.passed,
      target: targetIdentifier,
      originalCode,
      proposedCode,
      diff: diffResult.diffText,
      diffLines: diffResult.diffLines,
      instruction: input.instruction,
      securityChecksPassed: audit.passed,
      securityViolations: audit.violations,
      applied: false, // Invariant: edit_source never writes directly
      ...(audit.passed
        ? {}
        : {
            error: `Security guard rejected proposed edit: ${audit.violations.join(
              '; ',
            )}`,
          }),
    };
  }

  private resolveAndReadFile(
    targetPath: string,
  ): { success: boolean; sourceCode?: string; path?: string; error?: string } {
    const cwd = process.cwd();
    const cleanPath = targetPath.trim();

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

    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        success: false,
        error: `Path traversal outside project root is forbidden: ${targetPath}`,
      };
    }

    const isAllowed = EditSourceTool.ALLOWED_PREFIXES.some(
      (prefix) => rel === prefix || rel.startsWith(`${prefix}/`),
    );

    if (!isAllowed) {
      return {
        success: false,
        error: `Path '${targetPath}' is outside permitted source directories (${EditSourceTool.ALLOWED_PREFIXES.join(
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
      return { success: true, sourceCode, path: rel };
    } catch (err) {
      return {
        success: false,
        error: `Failed to read file: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  private computeUnifiedDiff(
    oldText: string,
    newText: string,
  ): { diffText: string; diffLines: DiffLine[] } {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const diffLines: DiffLine[] = [];
    const output: string[] = ['--- original', '+++ proposed'];

    let i = 0;
    let j = 0;

    while (i < oldLines.length || j < newLines.length) {
      const oldLine = oldLines[i];
      const newLine = newLines[j];

      if (oldLine !== undefined && oldLine === newLine) {
        diffLines.push({ type: 'same', text: oldLine });
        output.push(` ${oldLine}`);
        i++;
        j++;
      } else if (oldLine !== undefined && !newLines.includes(oldLine)) {
        diffLines.push({ type: 'del', text: oldLine });
        output.push(`-${oldLine}`);
        i++;
      } else if (newLine !== undefined && !oldLines.includes(newLine)) {
        diffLines.push({ type: 'add', text: newLine });
        output.push(`+${newLine}`);
        j++;
      } else {
        if (i < oldLines.length && oldLines[i] !== undefined) {
          const line = oldLines[i] as string;
          diffLines.push({ type: 'del', text: line });
          output.push(`-${line}`);
          i++;
        }
        if (j < newLines.length && newLines[j] !== undefined) {
          const line = newLines[j] as string;
          diffLines.push({ type: 'add', text: line });
          output.push(`+${line}`);
          j++;
        }
      }
    }

    return { diffText: output.join('\n'), diffLines };
  }

  private failureResult(
    target: string,
    error: string,
    instruction: string,
    originalCode = '',
  ): EditSourceOutput {
    return {
      success: false,
      target,
      originalCode,
      proposedCode: '',
      diff: '',
      diffLines: [],
      instruction,
      securityChecksPassed: false,
      securityViolations: [],
      applied: false,
      error,
    };
  }
}
