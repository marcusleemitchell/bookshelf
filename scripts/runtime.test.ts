import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScriptError,
  checkHealth,
  consoleOutput,
  isExecutable,
  isPortInUse,
  readDotEnv,
  resolveServerConfig,
  runCommand,
  serverUrl,
} from './runtime.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bookshelf-runtime-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const machine = { homeDir: '/Users/reader', systemTimeZone: 'Europe/London' };

describe('runCommand', () => {
  it('captures output and the exit code', async () => {
    const result = await runCommand(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    ]);
    expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('runs in the given directory without a shell', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'console.log(process.cwd())', '$HOME'],
      {
        cwd: dir,
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/bookshelf-runtime-/);
  });

  it('reports a command that cannot be started as exit 127', async () => {
    const result = await runCommand(join(dir, 'missing-binary'), []);
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('ENOENT');
  });

  it('kills a command that outlives its timeout', async () => {
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 100,
    });
    expect(result.code).toBe(1);
  });

  it('can connect the child to the terminal instead of capturing', async () => {
    const result = await runCommand(process.execPath, ['-e', 'process.exit(0)'], { inherit: true });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});

describe('consoleOutput', () => {
  it('writes lines to stdout and stderr', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    consoleOutput.out('hello');
    consoleOutput.err('oops');
    expect(out).toHaveBeenCalledWith('hello\n');
    expect(err).toHaveBeenCalledWith('oops\n');
  });
});

describe('isExecutable', () => {
  it('accepts executable files only', () => {
    const script = join(dir, 'run.sh');
    writeFileSync(script, '#!/bin/sh\n');
    expect(isExecutable(script)).toBe(false);
    chmodSync(script, 0o755);
    expect(isExecutable(script)).toBe(true);
    expect(isExecutable(dir)).toBe(false);
    expect(isExecutable(join(dir, 'missing'))).toBe(false);
  });
});

describe('readDotEnv', () => {
  it('is empty without a .env file', () => {
    expect(readDotEnv(dir)).toEqual({});
  });

  it('parses .env like the server does', () => {
    writeFileSync(
      join(dir, '.env'),
      '# comment\nPORT=4390\nBOOKSHELF_TZ="America/New_York"\nEMPTY=\nBOOKSHELF_DATA_DIR=~/Books # trailing\n',
    );
    expect(readDotEnv(dir)).toEqual({
      PORT: '4390',
      BOOKSHELF_TZ: 'America/New_York',
      EMPTY: '',
      BOOKSHELF_DATA_DIR: '~/Books',
    });
  });
});

describe('resolveServerConfig', () => {
  it('resolves the port and data directory with the server defaults', () => {
    const config = resolveServerConfig('/repo', {}, machine);
    expect(config.port).toBe(4380);
    expect(config.dataDir).toBe('/Users/reader/Library/Application Support/Bookshelf');
    expect(config.timeZone).toBe('Europe/London');
  });

  it('applies overrides and expands ~', () => {
    const config = resolveServerConfig(
      '/repo',
      { PORT: '4400', BOOKSHELF_DATA_DIR: '~/Books' },
      machine,
    );
    expect(config.port).toBe(4400);
    expect(config.dataDir).toBe('/Users/reader/Books');
  });

  it('reports invalid configuration as a ScriptError', () => {
    expect(() => resolveServerConfig('/repo', { PORT: 'nope' }, machine)).toThrow(ScriptError);
    expect(() => resolveServerConfig('/repo', { BOOKSHELF_TZ: 'Mars/Base' }, machine)).toThrow(
      /BOOKSHELF_TZ/,
    );
  });
});

describe('checkHealth', () => {
  it('returns the health response from the loopback server', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ ok: true, version: '0.1.0', dbPath: '/data/bookshelf.db' })),
    );
    await expect(checkHealth(fetchImpl, 4380)).resolves.toEqual({
      ok: true,
      version: '0.1.0',
      dbPath: '/data/bookshelf.db',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4380/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
    );
  });

  it('is null for errors, other servers and unreachable ports', async () => {
    await expect(
      checkHealth(() => Promise.resolve(new Response('nope', { status: 500 })), 4380),
    ).resolves.toBeNull();
    await expect(
      checkHealth(() => Promise.resolve(Response.json({ hello: 'world' })), 4380),
    ).resolves.toBeNull();
    await expect(
      checkHealth(() => Promise.reject(new TypeError('fetch failed')), 4380),
    ).resolves.toBeNull();
  });
});

describe('serverUrl', () => {
  it('is always the loopback address', () => {
    expect(serverUrl(4380)).toBe('http://127.0.0.1:4380');
  });
});

describe('isPortInUse (loopback only)', () => {
  let server: Server | null = null;
  afterEach(async () => {
    const running = server;
    server = null;
    if (running?.listening) {
      await new Promise((resolve) => running.close(resolve));
    }
  });

  it('detects a listener on 127.0.0.1 and a free port', async () => {
    const listener = createServer((socket) => socket.destroy());
    server = listener;
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await expect(isPortInUse(port)).resolves.toBe(true);
    await new Promise((resolve) => listener.close(resolve));
    await expect(isPortInUse(port)).resolves.toBe(false);
  });
});
