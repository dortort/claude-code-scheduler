import { describe, it, expect } from 'vitest';
import { exec, ExecError } from '../../utils/exec.js';

describe('exec', () => {
  it('returns stdout for successful command', async () => {
    const result = await exec('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('returns stderr alongside stdout', async () => {
    const result = await exec('node', ['-e', 'process.stderr.write("err"); process.stdout.write("out")']);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.exitCode).toBe(0);
  });

  it('throws ExecError on non-zero exit', async () => {
    await expect(exec('node', ['-e', 'process.exit(1)'])).rejects.toThrow(ExecError);
  });

  it('ExecError contains exit code and stderr', async () => {
    try {
      await exec('node', ['-e', 'process.stderr.write("fail"); process.exit(42)']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
      const execErr = err as ExecError;
      expect(execErr.exitCode).toBe(42);
      expect(execErr.stderr).toBe('fail');
    }
  });

  it('throws on command not found', async () => {
    await expect(exec('nonexistent-command-xyz', [])).rejects.toThrow();
  });

  it('supports stdin option', async () => {
    const result = await exec('cat', [], { stdin: 'hello from stdin' });
    expect(result.stdout).toBe('hello from stdin');
  });
});
