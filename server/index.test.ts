/**
 * Boots the real entry point in a child process against a temp data dir
 * (loopback only; no external network) to verify startup wiring, the
 * loopback bind and graceful shutdown. Coverage for index.ts is not
 * collected because it runs in a separate process.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookshelf-boot-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ['server/index.ts'], {
    cwd: repoRoot,
    env: { PATH: process.env['PATH'] ?? '', HOME: dir, BOOKSHELF_TZ: 'Europe/London', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
  const listening = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server did not start:\n${stdout}\n${stderr}`));
    }, 15_000);
    child.stdout.on('data', () => {
      if (stdout.includes('Bookshelf listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`Server exited early:\n${stdout}\n${stderr}`));
    });
  });
  return { child, exited, listening, output: () => ({ stdout, stderr }) };
}

describe('server entry point', () => {
  it('boots on 127.0.0.1, answers /api/health, snapshots and shuts down cleanly', async () => {
    const port = await freePort();
    const dataDir = join(dir, 'data');
    const server = start({ PORT: String(port), BOOKSHELF_DATA_DIR: dataDir });
    await server.listening;

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await res.json()).toEqual({
      ok: true,
      version: '0.2.0',
      dbPath: join(dataDir, 'bookshelf.db'),
    });
    expect(server.output().stdout).toContain(`"url":"http://127.0.0.1:${port}"`);
    expect(existsSync(join(dataDir, 'bookshelf.db'))).toBe(true);
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(1);
    expect(existsSync(join(dataDir, 'covers'))).toBe(true);

    server.child.kill('SIGTERM');
    expect(await server.exited).toBe(0);
    expect(server.output().stdout).toContain('"msg":"Shutting down"');
  }, 20_000);

  it('exits with a clear message when the configuration is invalid', async () => {
    const server = start({ PORT: 'eighty', BOOKSHELF_DATA_DIR: join(dir, 'data') });
    await expect(server.listening).rejects.toThrow('Server exited early');
    expect(await server.exited).toBe(1);
    expect(server.output().stderr).toContain(
      'Bookshelf failed to start: Invalid configuration: PORT',
    );
    expect(existsSync(join(dir, 'data'))).toBe(false);
  }, 20_000);
});
