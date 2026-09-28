/**
 * Security Guard for Code Sandboxing & Ratchet System
 *
 * Enforces zero-trust boundaries:
 * 1. Prohibits reading sensitive secrets / environment credentials.
 * 2. Prohibits writes to the main filesystem, project files, or path traversal outside sandbox.
 * 3. Prohibits unauthorized process execution / shell escapes.
 * 4. Prohibits unauthorized network access / socket servers when restricted.
 */

export interface SecurityAuditResult {
  passed: boolean;
  violations: string[];
  details?: Record<string, unknown>;
}

export interface SecurityPolicyOptions {
  allowNetwork?: boolean;
  allowFileSystem?: boolean;
  allowProcessSpawn?: boolean;
}

export class SandboxSecurityGuard {
  // Regex patterns for detecting attempts to exfiltrate secrets or probe sensitive environment variables
  private static readonly SECRET_PATTERNS = [
    /process\.env\.[A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASS|CREDENTIAL|AUTH|SEED|PRIVATE|OPENROUTER|GEMINI|GROQ)/i,
    /process\.env\[['"][A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASS|CREDENTIAL|AUTH|SEED|PRIVATE|OPENROUTER|GEMINI|GROQ)['"]\]/i,
    /Object\.(keys|values|entries)\(\s*process\.env\s*\)/,
    /JSON\.stringify\(\s*process\.env\s*\)/,
    /for\s*\(\s*(const|let|var)\s+.*(of|in)\s+process\.env\s*\)/,
  ];

  // Regex patterns for detecting dangerous filesystem writes or path traversal
  private static readonly FORBIDDEN_FS_WRITE_PATTERNS = [
    /fs\s*\.\s*(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(\s*['"`]((\.\.|\/|\\|src|\.env|package\.json).*?)['"`]/,
    /['"`](\.\.\/|\.\.\\|\/etc\/|\/root\/|\/home\/|\.env|package\.json)['"`]/,
  ];

  // Regex patterns for forbidden shell/child process execution
  private static readonly FORBIDDEN_EXEC_PATTERNS = [
    /require\s*\(\s*['"]child_process['"]\s*\)/,
    /from\s*['"]child_process['"]/,
    /\b(execSync|spawnSync|execFile|fork)\b/,
    /\b(curl|wget|bash|sh|sudo)\b\s+/,
  ];

  // Regex patterns for network sockets / servers when disallowed
  private static readonly FORBIDDEN_NETWORK_PATTERNS = [
    /require\s*\(\s*['"](http|https|net|dgram|tls)['"]\s*\)/,
    /from\s*['"](http|https|net|dgram|tls)['"]/,
    /\.createServer\s*\(/,
    /\.listen\s*\(/,
    /\bWebSocket\b/,
  ];

  /**
   * Statically audits source code for security violations.
   */
  public static auditSourceCode(
    sourceCode: string,
    options: SecurityPolicyOptions = {},
  ): SecurityAuditResult {
    const violations: string[] = [];

    // 1. Secrets & Credentials Access Check
    for (const pattern of this.SECRET_PATTERNS) {
      if (pattern.test(sourceCode)) {
        violations.push('Prohibited access to sensitive environment credentials / secrets.');
        break;
      }
    }

    // 2. Main Filesystem / Path Traversal Check
    if (!options.allowFileSystem) {
      for (const pattern of this.FORBIDDEN_FS_WRITE_PATTERNS) {
        if (pattern.test(sourceCode)) {
          violations.push('Prohibited filesystem write or path traversal detected.');
          break;
        }
      }
    }

    // 3. Child Process / Shell Escapes Check
    if (!options.allowProcessSpawn) {
      for (const pattern of this.FORBIDDEN_EXEC_PATTERNS) {
        if (pattern.test(sourceCode)) {
          violations.push('Prohibited child process or shell execution detected.');
          break;
        }
      }
    }

    // 4. Unauthorized Network Access Check
    if (options.allowNetwork === false) {
      for (const pattern of this.FORBIDDEN_NETWORK_PATTERNS) {
        if (pattern.test(sourceCode)) {
          violations.push('Prohibited unauthorized network / socket communication.');
          break;
        }
      }
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  }

  /**
   * Sanitizes environment variables to guarantee child processes
   * have zero access to API keys, private keys, or credentials.
   */
  public static getSanitizedEnv(customEnv?: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {
      NODE_ENV: 'sandbox',
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };

    // If custom non-sensitive env provided, copy only non-secret keys
    if (customEnv) {
      for (const [key, val] of Object.entries(customEnv)) {
        if (!/KEY|SECRET|TOKEN|PASS|CREDENTIAL|AUTH|SEED|PRIVATE/i.test(key)) {
          sanitized[key] = val;
        }
      }
    }

    return sanitized;
  }
}
