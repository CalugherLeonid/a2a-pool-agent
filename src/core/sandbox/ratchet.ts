import { evaluateScript } from './eval-pack.js';
import type { TestCase, EvalReport } from './eval-pack.js';

export interface RatchetState {
  version: number;
  code: string;
  score: number;
}

export class RatchetGuard {
  private currentState: RatchetState;
  private testCases: TestCase[];

  constructor(initialCode: string, initialScore: number, testCases: TestCase[]) {
    this.currentState = { version: 1, code: initialCode, score: initialScore };
    this.testCases = testCases;
  }

  /**
   * Încearcă să aplice o nouă versiune de cod (self-rewrite).
   * Ratchet rulează Eval Pack-ul. Acceptă modificarea DOAR dacă scorul este >= scorul curent.
   */
  async attemptUpgrade(newCode: string): Promise<{ accepted: boolean; report: EvalReport; version: number }> {
    const report = await evaluateScript(newCode, this.testCases);

    if (report.score >= this.currentState.score && report.passed) {
      this.currentState = {
        version: this.currentState.version + 1,
        code: newCode,
        score: report.score
      };
      return { accepted: true, report, version: this.currentState.version };
    }

    return { accepted: false, report, version: this.currentState.version };
  }

  getCurrentCode(): string {
    return this.currentState.code;
  }

  getCurrentVersion(): number {
    return this.currentState.version;
  }
}