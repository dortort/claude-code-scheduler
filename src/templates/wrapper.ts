/**
 * Bash script generators for scheduled task execution.
 * Produces self-contained wrapper scripts that handle:
 * - PATH restoration, working directory
 * - Timeout enforcement with SIGTERM/SIGKILL
 * - mkdir-based concurrency guard (one execution per task)
 * - Log file routing (stdout, stderr, status marker)
 * - Claude CLI invocation with proper escaping
 */

import { shellEscape } from '../utils/shell.js';

export interface WrapperOptions {
  taskId: string;
  taskName: string;
  command: string;
  workingDirectory: string;
  timeout: number;
  skipPermissions: boolean;
  logsDir: string;
  userPath: string;
}

export interface WorktreeWrapperOptions extends WrapperOptions {
  repoPath: string;
  branchPrefix: string;
  remoteName: string;
}

/**
 * Generate a bash wrapper script for direct (non-worktree) execution.
 */
export function generateDirectWrapper(options: WrapperOptions): string {
  const {
    taskId,
    taskName,
    command,
    workingDirectory,
    timeout,
    skipPermissions,
    logsDir,
    userPath,
  } = options;

  const escapedCommand = shellEscape(command);
  const skipFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
  const outLog = `${logsDir}/${taskId}.out.log`;
  const errLog = `${logsDir}/${taskId}.err.log`;
  const statusFile = `${logsDir}/${taskId}.status`;
  const lockFile = `/tmp/claude-scheduler-${taskId}.lock`;

  return `#!/bin/bash
# Claude Code Scheduler - Direct Wrapper
# Task: ${taskId} (${taskName.replace(/[#$`\\]/g, '')})
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
set -euo pipefail

# Restore user PATH
export PATH="${userPath}"

# Ensure logs directory exists
mkdir -p ${shellEscape(logsDir)}

# Change to working directory
cd ${shellEscape(workingDirectory)}

# Concurrency guard: only one execution per task at a time (mkdir-based, portable)
LOCKFILE=${shellEscape(lockFile)}
TIMEOUT=${timeout}

# Portable stat: Linux syntax first (GNU stat -f returns filesystem info, not file mtime)
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

if ! mkdir "$LOCKFILE" 2>/dev/null; then
  if [ -d "$LOCKFILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(file_mtime "$LOCKFILE") ))
    if [ "$LOCK_AGE" -gt $(( TIMEOUT + 60 )) ]; then
      LOCK_PID=$(cat "$LOCKFILE/pid" 2>/dev/null)
      if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "Task ${taskId} still running (PID $LOCK_PID), skipping." >&2
        exit 0
      fi
      rm -rf "$LOCKFILE"
      mkdir "$LOCKFILE" 2>/dev/null || { echo "Task ${taskId} already running, skipping." >&2; exit 0; }
    else
      echo "Task ${taskId} already running, skipping." >&2
      exit 0
    fi
  fi
fi
echo $$ > "$LOCKFILE/pid"

CLAUDE_PID=""

cleanup() {
  if [ -n "$CLAUDE_PID" ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
    kill -TERM "$CLAUDE_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  fi
  rm -rf "$LOCKFILE"
}
trap cleanup EXIT INT TERM

# Run claude with timeout
claude -p ${escapedCommand}${skipFlag} \\
  >"${outLog}" \\
  2>"${errLog}" &
CLAUDE_PID=$!

# Wait with timeout
if wait_with_timeout() {
  local pid=$1
  local timeout=$2
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
  return $?
}; then
  :
fi

if wait_with_timeout "$CLAUDE_PID" "$TIMEOUT"; then
  EXIT_CODE=$?
else
  # Timeout reached - kill the process
  kill -TERM "$CLAUDE_PID" 2>/dev/null || true
  sleep 5
  kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  echo "failure:timeout" > "${statusFile}"
  exit 1
fi

# Write status marker
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "success" > "${statusFile}"
else
  echo "failure:exit-$EXIT_CODE" > "${statusFile}"
fi

exit $EXIT_CODE
`;
}

/**
 * Generate a bash wrapper script for worktree-based execution.
 * Creates a git worktree, runs claude inside it, commits, pushes, and cleans up.
 */
export function generateWorktreeWrapper(options: WorktreeWrapperOptions): string {
  const {
    taskId,
    taskName,
    command,
    // workingDirectory not used - worktree runs in its own checkout directory
    timeout,
    skipPermissions,
    logsDir,
    userPath,
    repoPath,
    branchPrefix,
    remoteName,
  } = options;

  const escapedCommand = shellEscape(command);
  const skipFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
  const outLog = `${logsDir}/${taskId}.out.log`;
  const errLog = `${logsDir}/${taskId}.err.log`;
  const statusFile = `${logsDir}/${taskId}.status`;
  const lockFile = `/tmp/claude-scheduler-${taskId}.lock`;
  const escapedRemote = shellEscape(remoteName);
  const shortId = taskId.slice(0, 8);
  const branchName = `${branchPrefix}${shortId}-$(date +%s)`;
  const worktreeDir = `/tmp/claude-worktree-${taskId}-$$`;

  return `#!/bin/bash
# Claude Code Scheduler - Worktree Wrapper
# Task: ${taskId} (${taskName.replace(/[#$`\\]/g, '')})
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
set -euo pipefail

# Restore user PATH
export PATH="${userPath}"

# Ensure logs directory exists
mkdir -p ${shellEscape(logsDir)}

# Concurrency guard: only one execution per task at a time (mkdir-based, portable)
LOCKFILE=${shellEscape(lockFile)}
TIMEOUT=${timeout}

# Portable stat: Linux syntax first (GNU stat -f returns filesystem info, not file mtime)
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

if ! mkdir "$LOCKFILE" 2>/dev/null; then
  if [ -d "$LOCKFILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(file_mtime "$LOCKFILE") ))
    if [ "$LOCK_AGE" -gt $(( TIMEOUT + 60 )) ]; then
      LOCK_PID=$(cat "$LOCKFILE/pid" 2>/dev/null)
      if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "Task ${taskId} still running (PID $LOCK_PID), skipping." >&2
        exit 0
      fi
      rm -rf "$LOCKFILE"
      mkdir "$LOCKFILE" 2>/dev/null || { echo "Task ${taskId} already running, skipping." >&2; exit 0; }
    else
      echo "Task ${taskId} already running, skipping." >&2
      exit 0
    fi
  fi
fi
echo $$ > "$LOCKFILE/pid"

# Worktree setup
REPO_PATH=${shellEscape(repoPath)}
BRANCH_NAME="${branchName}"
WORKTREE_DIR="${worktreeDir}"
REMOTE=${escapedRemote}
CLAUDE_PID=""

# Cleanup handler - remove worktree and lock on exit
cleanup() {
  if [ -n "$CLAUDE_PID" ] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
    kill -TERM "$CLAUDE_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  fi
  if [ -d "$WORKTREE_DIR" ]; then
    cd "$REPO_PATH"
    git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true
  fi
  rm -rf "$LOCKFILE"
}
trap cleanup EXIT INT TERM

# Create worktree with new branch
cd "$REPO_PATH"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME"
cd "$WORKTREE_DIR"

# Run claude in the worktree directory
claude -p ${escapedCommand}${skipFlag} \\
  >"${outLog}" \\
  2>"${errLog}" &
CLAUDE_PID=$!

# Wait with timeout
wait_with_timeout() {
  local pid=$1
  local timeout=$2
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
  return $?
}

if wait_with_timeout "$CLAUDE_PID" "$TIMEOUT"; then
  EXIT_CODE=$?
  CLAUDE_PID=""
else
  # Timeout reached
  kill -TERM "$CLAUDE_PID" 2>/dev/null || true
  sleep 5
  kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  CLAUDE_PID=""
  echo "failure:timeout" > "${statusFile}"
  exit 1
fi

# Stage tracked changes only (not untracked - safer default)
cd "$WORKTREE_DIR"
git add -u

# Check if there are changes to commit
if git diff --cached --quiet; then
  echo "success:no-changes" > "${statusFile}"
else
  # Commit and push
  git commit -m "Claude scheduled task: ${taskName.replace(/"/g, '\\"')}"
  git push -u ${escapedRemote} "$BRANCH_NAME"
  echo "success" > "${statusFile}"
fi

# Cleanup worktree (trap will handle if we fail before here)
cd "$REPO_PATH"
git worktree remove "$WORKTREE_DIR" --force

exit \${EXIT_CODE:-0}
`;
}
