import path from 'node:path';
import type { RunRecord } from 'agentry';

/** Repo root, used as the Claude Code `--plugin-dir` so the scheduler plugin loads. */
export const SCHEDULER_ROOT = path.resolve(import.meta.dirname, '..');

/** Shared run options: load the scheduler plugin and skip interactive approvals. */
export const RUN_OPTS = { pluginDir: SCHEDULER_ROOT, permissionMode: 'bypassPermissions' } as const;

/** All assistant text from a run, joined — the analog of the old stdout+stderr capture. */
export function agentText(rec: RunRecord): string {
  return rec.assistantMessages.map((m) => m.payload.text).join('\n');
}

/** Assert the output contains at least one of the alternatives (case-insensitive). */
export function assertContainsAny(output: string, alternatives: string[]): void {
  const lower = output.toLowerCase();
  if (!alternatives.some((alt) => lower.includes(alt.toLowerCase()))) {
    throw new Error(
      `Expected output to contain at least one of [${alternatives.map((a) => `"${a}"`).join(', ')}] but none were found.\nOutput:\n${output}`,
    );
  }
}

/** Assert the output does NOT contain any of the patterns (case-insensitive). */
export function assertNotContains(output: string, patterns: string[]): void {
  const lower = output.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      throw new Error(`Expected output NOT to contain "${pattern}" but it was found.\nOutput:\n${output}`);
    }
  }
}
