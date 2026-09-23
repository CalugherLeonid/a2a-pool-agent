import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

export interface SandboxOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  workDir?: string;
}

export interface SandboxResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** Runs JavaScript in a separate Node.js process with bounded execution time. */
export class Sandbox {
  async executeCode(
    scriptPathOrCode: string,
    options: SandboxOptions = {},
  ): Promise<SandboxResult> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 10_000;

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt,
        error: 'timeoutMs must be a positive finite number',
      };
    }

    let targetFile: string;
    let temporaryFile: string | undefined;

    try {
      if (await this.isFile(scriptPathOrCode)) {
        targetFile = resolve(scriptPathOrCode);
      } else {
        const tempDir = join(process.cwd(), 'temp_sandbox');
        await mkdir(tempDir, { recursive: true });
        temporaryFile = join(tempDir, `sandbox-${randomUUID()}.js`);
        await writeFile(temporaryFile, scriptPathOrCode, 'utf8');
        targetFile = temporaryFile;
      }

      return await this.run(targetFile, timeoutMs, options, startedAt);
    } catch (err) {
      return {
        success: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: Date.now() - startedAt,
        error: this.errorMessage(err),
      };
    } finally {
      if (temporaryFile) {
        try {
          await rm(temporaryFile, { force: true });
        } catch {
          // Cleanup failures should not hide the execution result.
        }
      }
    }
  }

  private async isFile(value: string): Promise<boolean> {
    if (!existsSync(value)) return false;

    try {
      return (await stat(value)).isFile();
    } catch {
      return false;
    }
  }

  private run(
    targetFile: string,
    timeoutMs: number,
    options: SandboxOptions,
    startedAt: number,
  ): Promise<SandboxResult> {
    return new Promise((resolveResult) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let spawnError: string | undefined;
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        ...options.env,
      };

      let child;
      try {
        child = spawn('node', [targetFile], {
          cwd: options.workDir ?? process.cwd(),
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolveResult({
          success: false,
          exitCode: null,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          error: this.errorMessage(err),
        });
        return;
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      let forceKill: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        child.kill('SIGTERM');
        forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, 250);
      }, timeoutMs);

      child.once('error', (err) => {
        spawnError = this.errorMessage(err);
      });

      child.once('close', (exitCode) => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        const error = timedOut
          ? `execution timed out after ${timeoutMs}ms`
          : spawnError;

        resolveResult({
          success: exitCode === 0 && !error,
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          ...(error ? { error } : {}),
        });
      });
    });
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
