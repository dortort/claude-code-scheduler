/**
 * Init command: installs the shared executor to a stable path.
 * Copies executor.js to ~/.claude/bin/claude-scheduler-executor.js
 * and writes a bash shim to ~/.claude/bin/claude-scheduler-run.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface InitResult {
  success: boolean;
  executorPath: string;
  shimPath: string;
  error?: string;
}

function getBinDir(): string {
  return path.join(os.homedir(), '.claude', 'bin');
}

export function getExecutorPath(): string {
  return resolveExecutorInPlace();
}

export function getShimPath(): string {
  return path.join(getBinDir(), 'claude-scheduler-run');
}

const SHIM_TEMPLATE = `#!/bin/bash
# Claude Code Scheduler - Shared Executor Shim
# Installed by: claude-scheduler init
set -euo pipefail

# Restore user PATH (launchd provides minimal PATH without node/claude)
export PATH="{{USER_PATH}}"

EXECUTOR="{{EXECUTOR_PATH}}"
if [ ! -f "$EXECUTOR" ]; then
  echo "Executor not found at $EXECUTOR. Run /scheduler:add to reinstall." >&2
  exit 1
fi
exec {{NODE_PATH}} "$EXECUTOR" "$@"
`;

/**
 * Find the executor source in the plugin cache or local dist.
 * Returns the absolute path to executor.js that has valid relative imports.
 */
function resolveExecutorInPlace(): string {
  // This file is at dist/cli/commands/init.js (or src/cli/commands/init.ts)
  // The executor is at dist/cli/executor.js (sibling directory)
  const fromModule = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'executor.js');
  return fromModule;
}

export async function init(): Promise<InitResult> {
  const binDir = getBinDir();
  const shimDest = getShimPath();

  // Resolve executor in place (keeps relative imports intact)
  const executorPath = resolveExecutorInPlace();

  try {
    await fs.mkdir(binDir, { recursive: true });

    // Resolve absolute path to node (eliminates PATH dependency for shim startup)
    const nodePath = process.execPath;

    // Write bash shim with absolute node path and user's PATH embedded
    const userPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    const shimContent = SHIM_TEMPLATE
      .replace('{{EXECUTOR_PATH}}', executorPath)
      .replace('{{NODE_PATH}}', nodePath)
      .replace('{{USER_PATH}}', userPath);
    await fs.writeFile(shimDest, shimContent, { mode: 0o755 });

    return { success: true, executorPath, shimPath: shimDest };
  } catch (err) {
    return {
      success: false,
      executorPath,
      shimPath: shimDest,
      error: (err as Error).message,
    };
  }
}

/**
 * Check if the executor is installed. Returns true if both files exist.
 */
export async function isExecutorInstalled(): Promise<boolean> {
  try {
    await fs.access(getShimPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the executor is installed. Runs init if not.
 */
export async function ensureExecutorInstalled(): Promise<InitResult> {
  if (await isExecutorInstalled()) {
    return { success: true, executorPath: getExecutorPath(), shimPath: getShimPath() };
  }
  return init();
}
