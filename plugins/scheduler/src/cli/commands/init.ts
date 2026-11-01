/**
 * Init command: writes shims to ~/.claude/bin/ for the scheduler.
 *
 * Two shims are installed:
 * - claude-scheduler-run: executes scheduled tasks (used by launchd/cron)
 * - claude-scheduler-cli: exposes CLI subcommands (used by skill commands)
 *
 * Both embed absolute paths to node and the dist directory, so they work
 * regardless of the caller's working directory or PATH. Re-running init
 * is always safe and updates both shims to match the current plugin cache
 * and node location.
 */

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { writeFileAtomic } from '../../utils/atomic.js';

export interface InitResult {
  success: boolean;
  executorPath: string;
  shimPath: string;
  cliShimPath: string;
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

export function getCliShimPath(): string {
  return path.join(getBinDir(), 'claude-scheduler-cli');
}

const SHIM_TEMPLATE = `#!/bin/bash
# Claude Code Scheduler - Shared Executor Shim
# Installed by: claude-scheduler init
set -euo pipefail

# Restore user PATH (launchd provides minimal PATH without node/claude)
export PATH="{{USER_PATH}}"

# Ensure USER is set (launchd does not provide it; Claude CLI needs it for auth)
export USER="\${USER:-$(whoami)}"

EXECUTOR="{{EXECUTOR_PATH}}"
if [ ! -f "$EXECUTOR" ]; then
  echo "Executor not found at $EXECUTOR. Run /scheduler:add to reinstall." >&2
  exit 1
fi
exec {{NODE_PATH}} "$EXECUTOR" "$@"
`;

const CLI_SHIM_TEMPLATE = `#!/bin/bash
# Claude Code Scheduler - CLI Shim
# Installed by: claude-scheduler init
set -euo pipefail

CLI_ENTRY="{{CLI_ENTRY_PATH}}"
if [ ! -f "$CLI_ENTRY" ]; then
  echo "CLI entry not found at $CLI_ENTRY. Run /scheduler:add to reinstall." >&2
  exit 1
fi
exec {{NODE_PATH}} "$CLI_ENTRY" "$@"
`;

/**
 * Resolve the CLI entry point (dist/cli/index.js) from this module's location.
 */
function resolveCliEntryInPlace(): string {
  // This file is at dist/cli/commands/init.js
  // The CLI entry is at dist/cli/index.js (parent directory)
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.js');
}

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
  const cliShimDest = getCliShimPath();

  // Resolve paths in place (keeps relative imports intact)
  const executorPath = resolveExecutorInPlace();
  const cliEntryPath = resolveCliEntryInPlace();

  try {
    await fs.mkdir(binDir, { recursive: true });

    // Resolve absolute path to node (eliminates PATH dependency for shim startup)
    const nodePath = process.execPath;

    // Write executor shim with absolute node path and user's PATH embedded
    const userPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    const shimContent = SHIM_TEMPLATE
      .replace('{{EXECUTOR_PATH}}', executorPath)
      .replace('{{NODE_PATH}}', nodePath)
      .replace('{{USER_PATH}}', userPath);
    await writeFileAtomic(shimDest, shimContent, { mode: 0o755 });

    // Write CLI shim (no PATH restore needed — runs interactively)
    const cliShimContent = CLI_SHIM_TEMPLATE
      .replace('{{CLI_ENTRY_PATH}}', cliEntryPath)
      .replace('{{NODE_PATH}}', nodePath);
    await writeFileAtomic(cliShimDest, cliShimContent, { mode: 0o755 });

    return { success: true, executorPath, shimPath: shimDest, cliShimPath: cliShimDest };
  } catch (err) {
    return {
      success: false,
      executorPath,
      shimPath: shimDest,
      cliShimPath: cliShimDest,
      error: (err as Error).message,
    };
  }
}

/**
 * Ensure the executor shim is installed and up to date.
 * Always re-runs init to refresh the shim with current paths.
 * This handles plugin upgrades (cache path changes) and node
 * version changes transparently.
 */
export async function ensureExecutorInstalled(): Promise<InitResult> {
  return init();
}

/**
 * Resolve the absolute path to the `claude` binary using the current PATH.
 * Returns undefined if `claude` is not found.
 */
export async function resolveClaudeBin(): Promise<string | undefined> {
  const shell = process.env.SHELL?.endsWith('/zsh') ? '/bin/zsh' : '/bin/bash';
  return new Promise((resolve) => {
    execFile(shell, ['-lc', 'command -v claude'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const resolved = stdout.trim();
      resolve(resolved || undefined);
    });
  });
}
