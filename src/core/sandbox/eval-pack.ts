import { runInSandbox } from './worker-runner.js';

export interface TestCase {
  id: string;
  input?: string;
  expectedOutputSubstring?: string;
  validator?: (stdout: string) => boolean;
}

export interface EvalReport {
  passed: boolean;
  score: number; // 0 la 1 (procentaj de teste trecute)
  details: { testId: string; success: boolean; error?: string }[];
}

export async function evaluateScript(
  scriptContent: string, 
  testCases: TestCase[]
): Promise<EvalReport> {
  if (testCases.length === 0) {
    return { passed: true, score: 1.0, details: [] };
  }

  let passedCount = 0;
  const details = [];

  for (const test of testCases) {
    // Rulăm scriptul în sandbox
    const result = await runInSandbox(scriptContent);

    if (!result.success) {
      details.push({ testId: test.id, success: false, error: result.stderr || 'Execution failed' });
      continue;
    }

    let matches = true;
    if (test.expectedOutputSubstring) {
      matches = result.stdout.includes(test.expectedOutputSubstring);
    }
    if (test.validator) {
      matches = matches && test.validator(result.stdout);
    }

    if (matches) {
      passedCount++;
      details.push({ testId: test.id, success: true });
    } else {
      details.push({ testId: test.id, success: false, error: `Output mismatch. Got: ${result.stdout.trim()}` });
    }
  }

  const score = passedCount / testCases.length;
  return {
    passed: score === 1.0,
    score,
    details
  };
}