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
  return path.join(getBinDir(), 'claude-scheduler-executor.js');
}

export function getShimPath(): string {
  return path.join(getBinDir(), 'claude-scheduler-run');
}

/**
 * Find the executor source file relative to this module.
 * Works whether invoked from src/ or dist/.
 */
function getExecutorSourcePath(): string {
  // This file is at src/cli/commands/init.ts or dist/cli/commands/init.js
  // Executor is at src/cli/executor.ts or dist/cli/executor.js
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'executor.js');
}

const SHIM_TEMPLATE = `#!/bin/bash
# Claude Code Scheduler - Shared Executor Shim
# Installed by: claude-scheduler init
set -euo pipefail

# Restore user PATH (launchd provides minimal PATH without node)
export PATH="{{USER_PATH}}"

EXECUTOR="{{EXECUTOR_PATH}}"
if [ ! -f "$EXECUTOR" ]; then
  echo "Executor not found at $EXECUTOR. Run /scheduler:add to reinstall." >&2
  exit 1
fi
exec node "$EXECUTOR" "$@"
`;

export async function init(): Promise<InitResult> {
  const binDir = getBinDir();
  const executorDest = getExecutorPath();
  const shimDest = getShimPath();

  try {
    await fs.mkdir(binDir, { recursive: true });

    // Copy executor source to stable path
    const executorSource = getExecutorSourcePath();
    await fs.copyFile(executorSource, executorDest);

    // Write bash shim with user's PATH embedded
    const userPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    const shimContent = SHIM_TEMPLATE
      .replace('{{EXECUTOR_PATH}}', executorDest)
      .replace('{{USER_PATH}}', userPath);
    await fs.writeFile(shimDest, shimContent, { mode: 0o755 });

    return { success: true, executorPath: executorDest, shimPath: shimDest };
  } catch (err) {
    return {
      success: false,
      executorPath: executorDest,
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
    await fs.access(getExecutorPath());
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
