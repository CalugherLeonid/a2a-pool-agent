import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export interface SandboxOptions {
  timeoutMs?: number;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  latencyMs: number;
  success: boolean;
}

export async function runInSandbox(
  scriptContent: string, 
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs || 5000;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sandbox-'));
  const scriptPath = path.join(tempDir, 'payload.js');

  await fs.writeFile(scriptPath, scriptContent, 'utf-8');
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = execFile(
      'node', 
      [scriptPath], 
      {
        timeout: timeoutMs,
        cwd: tempDir,
        env: { NODE_ENV: 'sandbox', PATH: process.env.PATH }
      }, 
      async (error, stdout, stderr) => {
        const latencyMs = Date.now() - startTime;
        
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          // Ignoră erorile de cleanup
        }

        resolve({
          stdout: stdout || '',
          stderr: stderr || (error ? error.message : ''),
          exitCode: child.exitCode,
          latencyMs,
          success: !error && child.exitCode === 0
        });
      }
    );
  });
}