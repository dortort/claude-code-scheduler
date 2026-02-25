/**
 * Thin Promise wrapper over child_process.execFile/spawn.
 * Replaces execa dependency with Node.js builtins.
 */

import { execFile, spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout?: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

/**
 * Execute a command and return its output.
 * Throws ExecError on non-zero exit code or if the command is not found.
 */
export async function exec(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options?.stdin !== undefined) {
      // Use spawn for stdin support
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : undefined,
        timeout: options?.timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (err: Error) => {
        reject(err);
      });

      child.on('close', (code: number | null) => {
        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          reject(new ExecError(
            `Command failed: ${command} ${args.join(' ')} (exit ${exitCode})`,
            exitCode,
            stdout,
            stderr,
          ));
        } else {
          resolve({ stdout, stderr, exitCode });
        }
      });

      child.stdin.write(options.stdin);
      child.stdin.end();
    } else {
      // Use execFile for simpler cases
      execFile(
        command,
        args,
        {
          cwd: options?.cwd,
          env: options?.env ? { ...process.env, ...options.env } : undefined,
          timeout: options?.timeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        },
        (error, stdout, stderr) => {
          if (error) {
            // Command not found
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(error);
              return;
            }
            // Non-zero exit code - extract from error
            const exitCode = typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : (error.message.match(/exit code (\d+)/)?.[1] ? parseInt(error.message.match(/exit code (\d+)/)![1]) : 1);
            reject(new ExecError(
              `Command failed: ${command} ${args.join(' ')} (exit ${exitCode})`,
              exitCode,
              stdout,
              stderr,
            ));
          } else {
            resolve({ stdout, stderr, exitCode: 0 });
          }
        },
      );
    }
  });
}
