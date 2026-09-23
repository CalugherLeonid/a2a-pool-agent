import { promises as fs } from 'fs';
import path from 'path';
import type { RatchetGuard } from '../sandbox/ratchet.js';

export class AgentMetaTools {
  private baseDir: string;
  private ratchet: RatchetGuard;

  constructor(baseDir: string, ratchet: RatchetGuard) {
    this.baseDir = baseDir;
    this.ratchet = ratchet;
  }

  /**
   * Meta-Tool: read_source
   * Permite agentului să citească un fișier din proiect în mod sigur.
   */
  async readSource(relativePath: string): Promise<string> {
    const safePath = path.resolve(this.baseDir, relativePath);
    if (!safePath.startsWith(path.resolve(this.baseDir))) {
      throw new Error('Access denied: Path traversal outside project root.');
    }
    return await fs.readFile(safePath, 'utf-8');
  }

  /**
   * Meta-Tool: edit_source_with_ratchet
   * Modifică codul și îl trece prin testele Ratchet. Dacă pică, face auto-rollback.
   */
  async editSourceWithRatchet(relativePath: string, newContent: string) {
    const safePath = path.resolve(this.baseDir, relativePath);
    if (!safePath.startsWith(path.resolve(this.baseDir))) {
      throw new Error('Access denied: Path traversal outside project root.');
    }

    // Încercăm upgrade-ul prin Ratchet Guard
    const upgradeResult = await this.ratchet.attemptUpgrade(newContent);

    if (upgradeResult.accepted) {
      // Dacă testele au trecut, scriem efectiv fișierul în disc
      await fs.writeFile(safePath, newContent, 'utf-8');
      return {
        success: true,
        version: upgradeResult.version,
        message: `Upgrade accepted and applied successfully (v${upgradeResult.version}).`
      };
    } else {
      // Auto-rollback: Fișierul nu se atinge, modificarea este respinsă
      return {
        success: false,
        version: upgradeResult.version,
        error: 'Ratchet validation failed. Changes rejected and rolled back.',
        report: upgradeResult.report
      };
    }
  }
}