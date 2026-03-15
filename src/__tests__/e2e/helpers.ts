/**
 * E2E test helpers: subprocess runner + assertion utilities.
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a scheduler plugin command via the Claude CLI subprocess.
 *
 * Resolves on the `exit` event (not `close`) to avoid hangs when child
 * processes spawned by hooks keep inherited pipes open. A short drain
 * delay after exit ensures buffered stdout/stderr data is captured.
 */
export async function runSchedulerCommand(
  command: string,
  cwd: string,
  extraPrompt?: string,
): Promise<CommandResult> {
  const prompt = extraPrompt
    ? `/scheduler:${command} ${extraPrompt}`
    : `/scheduler:${command}`;

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['--plugin-dir', PROJECT_ROOT, '-p', prompt],
      {
        cwd,

        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Short delay to let remaining pipe data flush before resolving
      setTimeout(() => resolve({ stdout, stderr, exitCode }), 200);
    };

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
        settle(-1);
      }
    }, 115_000);

    // Use `exit` instead of `close` — `close` waits for all pipes to close,
    // which can hang if hooks spawn children that inherit the FDs.
    child.on('exit', (code: number | null) => {
      settle(code ?? 1);
    });

    child.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/**
 * Assert that the output contains all of the given patterns (case-insensitive).
 */
export function assertContains(output: string, patterns: string[]): void {
  const lower = output.toLowerCase();
  for (const pattern of patterns) {
    if (!lower.includes(pattern.toLowerCase())) {
      throw new Error(
        `Expected output to contain "${pattern}" but it did not.\nOutput:\n${output}`,
      );
    }
  }
}

/**
 * Assert that the output contains at least one of the given alternatives (case-insensitive).
 */
export function assertContainsAny(output: string, alternatives: string[]): void {
  const lower = output.toLowerCase();
  const found = alternatives.some((alt) => lower.includes(alt.toLowerCase()));
  if (!found) {
    throw new Error(
      `Expected output to contain at least one of [${alternatives.map((a) => `"${a}"`).join(', ')}] but none were found.\nOutput:\n${output}`,
    );
  }
}

/**
 * Assert that the output does NOT contain any of the given patterns (case-insensitive).
 */
export function assertNotContains(output: string, patterns: string[]): void {
  const lower = output.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      throw new Error(
        `Expected output NOT to contain "${pattern}" but it was found.\nOutput:\n${output}`,
      );
    }
  }
}

/**
 * Check if the `claude` CLI is available on the system.
 */
export async function checkClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', ['claude'], { timeout: 5_000 }, (error) => {
      resolve(!error);
    });
  });
}
