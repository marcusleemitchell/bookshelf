import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, RunOptions } from './runtime.ts';
import {
  APP_CLI_PATH,
  INSTALL_INSTRUCTIONS,
  findBookshelfMapping,
  findTailscale,
  main,
  parseStatus,
  readinessProblem,
  systemTailscaleDeps,
  type TailscaleDeps,
} from './tailscale.ts';

// Shapes of `tailscale status --json` and `tailscale serve status --json`
// as printed by Tailscale 1.104 on macOS (trimmed; fictional names).
const HOST = 'reading-mac.tail1234.ts.net';

function statusJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Version: '1.104.7-tfb3b9b296-g0651cc45e',
    TUN: false,
    BackendState: 'Running',
    HaveNodeKey: true,
    AuthURL: '',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    Self: { ID: 'n1', HostName: 'reading-mac', DNSName: `${HOST}.`, OS: 'macOS', Online: true },
    Health: [],
    MagicDNSSuffix: 'tail1234.ts.net',
    CurrentTailnet: {
      Name: 'reader@example.com',
      MagicDNSSuffix: 'tail1234.ts.net',
      MagicDNSEnabled: true,
    },
    CertDomains: [HOST],
    Peer: {},
    User: {},
    ...overrides,
  });
}

function serveJson(port = 4380, httpsPort = 443, mount = '/'): string {
  return JSON.stringify({
    TCP: { [String(httpsPort)]: { HTTPS: true } },
    Web: {
      [`${HOST}:${httpsPort}`]: { Handlers: { [mount]: { Proxy: `http://127.0.0.1:${port}` } } },
    },
  });
}

describe('findTailscale', () => {
  it('prefers tailscale on PATH, then the Mac app', () => {
    const present = new Set(['/opt/homebrew/bin/tailscale', APP_CLI_PATH]);
    const executable = (path: string) => present.has(path);
    expect(findTailscale('bin:/usr/bin:/opt/homebrew/bin', executable)).toBe(
      '/opt/homebrew/bin/tailscale',
    );
    expect(findTailscale('/usr/bin', executable)).toBe(APP_CLI_PATH);
    expect(findTailscale(undefined, executable)).toBe(APP_CLI_PATH);
    expect(findTailscale('/usr/bin', () => false)).toBeNull();
  });
});

describe('parseStatus', () => {
  it('reads state, DNS name, certificate domains and MagicDNS', () => {
    expect(parseStatus(JSON.parse(statusJson()))).toEqual({
      backendState: 'Running',
      dnsName: HOST,
      certDomains: [HOST],
      magicDnsEnabled: true,
    });
  });

  it('copes with a signed-out client', () => {
    expect(
      parseStatus({
        BackendState: 'NeedsLogin',
        Self: { DNSName: '' },
        CertDomains: null,
        CurrentTailnet: null,
      }),
    ).toEqual({
      backendState: 'NeedsLogin',
      dnsName: null,
      certDomains: [],
      magicDnsEnabled: null,
    });
  });

  it('rejects unexpected output', () => {
    expect(() => parseStatus([])).toThrow('Unexpected output');
    expect(() => parseStatus({ BackendState: 3 })).toThrow('Unexpected output');
  });
});

describe('findBookshelfMapping', () => {
  it('finds the HTTPS handler that proxies to the Bookshelf port', () => {
    expect(findBookshelfMapping(JSON.parse(serveJson()), 4380)).toEqual({
      url: `https://${HOST}/`,
      httpsPort: 443,
    });
  });

  it('includes a non-default HTTPS port and mount path', () => {
    expect(findBookshelfMapping(JSON.parse(serveJson(4380, 8443, '/books')), 4380)).toEqual({
      url: `https://${HOST}:8443/books/`,
      httpsPort: 8443,
    });
  });

  it('accepts localhost and bare host:port proxy targets', () => {
    const json = { Web: { [HOST]: { Handlers: { '/': { Proxy: 'localhost:4380' } } } } };
    expect(findBookshelfMapping(json, 4380)).toEqual({ url: `https://${HOST}/`, httpsPort: 443 });
  });

  it('ignores other services, other ports and empty configs', () => {
    expect(findBookshelfMapping({}, 4380)).toBeNull();
    expect(findBookshelfMapping(JSON.parse(serveJson(3000)), 4380)).toBeNull();
    expect(findBookshelfMapping(JSON.parse(serveJson(43800)), 4380)).toBeNull();
    expect(
      findBookshelfMapping(
        { Web: { [`${HOST}:443`]: { Handlers: { '/': { Path: '/var/www' } } }, other: null } },
        4380,
      ),
    ).toBeNull();
  });
});

describe('readinessProblem', () => {
  const ready = parseStatus(JSON.parse(statusJson()));

  it('is null when signed in with HTTPS certificates', () => {
    expect(readinessProblem(ready)).toBeNull();
  });

  it('explains how to sign in, connect or wait', () => {
    expect(readinessProblem({ ...ready, backendState: 'NeedsLogin' })).toContain('not signed in');
    expect(readinessProblem({ ...ready, backendState: 'NeedsMachineAuth' })).toContain(
      'not signed in',
    );
    expect(readinessProblem({ ...ready, backendState: 'Stopped' })).toContain('disconnected');
    expect(readinessProblem({ ...ready, backendState: 'Starting' })).toContain('state: Starting');
  });

  it('explains how to enable HTTPS certificates (and MagicDNS when off)', () => {
    expect(readinessProblem({ ...ready, certDomains: [] })).toBe(
      [
        'HTTPS certificates are not enabled for your tailnet, and the iPhone app needs HTTPS.',
        'In the Tailscale admin console (https://login.tailscale.com/admin/dns):',
        '  1. Under "HTTPS Certificates", choose Enable HTTPS.',
        'Then run `npm run tailscale:serve` again.',
      ].join('\n'),
    );
    const both = readinessProblem({ ...ready, certDomains: [], magicDnsEnabled: false });
    expect(both).toContain('  1. Enable MagicDNS.');
    expect(both).toContain('  2. Under "HTTPS Certificates"');
  });
});

// ---------------------------------------------------------------------------
// Command logic with the Tailscale CLI faked.

interface Call {
  command: string;
  args: readonly string[];
  options: RunOptions | undefined;
}

interface HarnessOptions {
  cli?: string | null;
  status?: string;
  /** Serve config before any command; `serve --bg` adds the Bookshelf mapping. */
  served?: boolean;
  healthy?: boolean;
  dotEnv?: string;
  override?: (call: Call) => CommandResult | undefined;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bookshelf-tailscale-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness(options: HarnessOptions = {}) {
  const repoRoot = join(root, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  if (options.dotEnv !== undefined) writeFileSync(join(repoRoot, '.env'), options.dotEnv);
  const cli = options.cli === undefined ? APP_CLI_PATH : options.cli;
  let served = options.served ?? false;
  let servedPort = 4380;
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ok = (text = ''): CommandResult => ({ code: 0, stdout: text, stderr: '' });
  const deps: TailscaleDeps = {
    repoRoot,
    homeDir: join(root, 'home'),
    systemTimeZone: 'Europe/London',
    pathEnv: '/usr/bin:/bin',
    isExecutable: (path) => path === cli,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    run: (command, args, runOptions) => {
      const call = { command, args, options: runOptions };
      calls.push(call);
      const overridden = options.override?.(call);
      if (overridden) return Promise.resolve(overridden);
      if (command !== cli) throw new Error(`Unexpected command in test: ${command}`);
      const key = args.join(' ');
      if (key === 'status --json') return Promise.resolve(ok(options.status ?? statusJson()));
      if (key === 'serve status --json')
        return Promise.resolve(ok(served ? serveJson(servedPort) : '{}'));
      if (args[0] === 'serve' && args[1] === '--bg') {
        served = true;
        servedPort = Number(args[2]);
        return Promise.resolve(ok());
      }
      if (args[0] === 'serve' && args[2] === 'off') {
        served = false;
        return Promise.resolve(ok());
      }
      throw new Error(`Unexpected tailscale call in test: ${key}`);
    },
    fetch: () =>
      options.healthy === false
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(
            Response.json({ ok: true, version: '0.1.0', dbPath: '/data/bookshelf.db' }),
          ),
  };
  return { deps, calls, stdout, stderr };
}

const argsOf = (calls: Call[]) => calls.map((c) => c.args.join(' '));

describe('main', () => {
  it('prints usage for help, no command and unknown commands', async () => {
    const h = harness();
    await expect(main(['--help'], h.deps)).resolves.toBe(0);
    expect(h.stdout[0]).toContain('Usage: node scripts/tailscale.ts <command>');
    await expect(main([], h.deps)).resolves.toBe(2);
    await expect(main(['funnel'], h.deps)).resolves.toBe(2);
    expect(h.stderr.join('\n')).toContain('Unknown command "funnel".');
  });

  it('prints install instructions when Tailscale is missing', async () => {
    for (const command of ['serve', 'status', 'off']) {
      const h = harness({ cli: null });
      await expect(main([command], h.deps)).resolves.toBe(1);
      expect(h.stderr.join('\n')).toBe(INSTALL_INSTRUCTIONS);
      expect(h.calls).toEqual([]);
    }
    expect(INSTALL_INSTRUCTIONS).toContain('brew install --cask tailscale-app');
    expect(INSTALL_INSTRUCTIONS).toContain('Mac App Store');
  });

  it('rethrows unexpected errors', async () => {
    const h = harness({
      override: () => {
        throw new Error('boom');
      },
    });
    await expect(main(['status'], h.deps)).rejects.toThrow('boom');
  });
});

describe('serve', () => {
  it('runs tailscale serve --bg on the server port and prints the HTTPS address', async () => {
    const h = harness();
    await expect(main(['serve'], h.deps)).resolves.toBe(0);
    expect(argsOf(h.calls)).toEqual([
      'status --json',
      'serve status --json',
      'serve --bg 4380',
      'serve status --json',
    ]);
    expect(h.calls[2]?.options).toEqual({ inherit: true });
    expect(h.calls[0]?.options).toEqual({ timeoutMs: 15_000 });
    expect(h.stdout).toContain(`Bookshelf is now on your tailnet at https://${HOST}/`);
    expect(h.stdout.join('\n')).toContain('Share → Add to Home Screen');
    expect(h.stderr).toEqual([]);
  });

  it('uses PORT from .env and the CLI on PATH', async () => {
    const h = harness({ dotEnv: 'PORT=4390\n', cli: '/opt/homebrew/bin/tailscale' });
    h.deps.pathEnv = '/opt/homebrew/bin:/usr/bin';
    await expect(main(['serve'], h.deps)).resolves.toBe(0);
    expect(h.calls.every((c) => c.command === '/opt/homebrew/bin/tailscale')).toBe(true);
    expect(argsOf(h.calls)).toContain('serve --bg 4390');
  });

  it('does nothing when Bookshelf is already served', async () => {
    const h = harness({ served: true });
    await expect(main(['serve'], h.deps)).resolves.toBe(0);
    expect(argsOf(h.calls)).toEqual(['status --json', 'serve status --json']);
    expect(h.stdout).toEqual([`Tailscale already serves Bookshelf at https://${HOST}/`]);
  });

  it('warns but continues when the server is not running yet', async () => {
    const h = harness({ healthy: false });
    await expect(main(['serve'], h.deps)).resolves.toBe(0);
    expect(h.stderr[0]).toContain('Bookshelf is not answering on http://127.0.0.1:4380 yet');
  });

  it('stops with instructions when Tailscale is signed out or HTTPS is off', async () => {
    const signedOut = harness({
      status: statusJson({ BackendState: 'NeedsLogin', CertDomains: null }),
    });
    await expect(main(['serve'], signedOut.deps)).resolves.toBe(1);
    expect(signedOut.stderr.join('\n')).toContain('not signed in');
    expect(argsOf(signedOut.calls)).toEqual(['status --json']);

    const noHttps = harness({ status: statusJson({ CertDomains: null }) });
    await expect(main(['serve'], noHttps.deps)).resolves.toBe(1);
    expect(noHttps.stderr.join('\n')).toContain('Enable HTTPS');
    expect(argsOf(noHttps.calls)).toEqual(['status --json']);
  });

  it('reports CLI failures', async () => {
    const serveFails = harness({
      override: (call) =>
        call.args[1] === '--bg' ? { code: 1, stdout: '', stderr: '' } : undefined,
    });
    await expect(main(['serve'], serveFails.deps)).resolves.toBe(1);
    expect(serveFails.stderr.join('\n')).toContain(
      '`tailscale serve` failed; see the message above.',
    );

    const daemonDown = harness({
      override: (call) =>
        call.args[0] === 'status'
          ? { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled\nmore detail' }
          : undefined,
    });
    await expect(main(['serve'], daemonDown.deps)).resolves.toBe(1);
    expect(daemonDown.stderr.join('\n')).toBe(
      '`tailscale status --json` failed (exit 1): failed to connect to local tailscaled. Is the Tailscale app running?',
    );

    const silentFailure = harness({
      override: (call) =>
        call.args[0] === 'status' ? { code: 2, stdout: '', stderr: '' } : undefined,
    });
    await expect(main(['serve'], silentFailure.deps)).resolves.toBe(1);
    expect(silentFailure.stderr.join('\n')).toBe(
      '`tailscale status --json` failed (exit 2). Is the Tailscale app running?',
    );

    const garbage = harness({
      override: (call) =>
        call.args[0] === 'status' ? { code: 0, stdout: 'not json', stderr: '' } : undefined,
    });
    await expect(main(['serve'], garbage.deps)).resolves.toBe(1);
    expect(garbage.stderr.join('\n')).toBe('Unexpected output from `tailscale status --json`.');
  });

  it('reports a serve that leaves no Bookshelf mapping behind', async () => {
    const h = harness({
      override: (call) =>
        call.args[1] === '--bg' ? { code: 0, stdout: '', stderr: '' } : undefined,
    });
    await expect(main(['serve'], h.deps)).resolves.toBe(1);
    expect(h.stderr.join('\n')).toContain('no HTTPS address for Bookshelf is configured');
  });

  it('stops on invalid configuration', async () => {
    const h = harness({ dotEnv: 'PORT=0\n' });
    await expect(main(['serve'], h.deps)).resolves.toBe(1);
    expect(h.stderr.join('\n')).toContain('Invalid configuration: PORT');
  });
});

describe('status', () => {
  it('shows the Bookshelf address when served', async () => {
    const h = harness({ served: true });
    await expect(main(['status'], h.deps)).resolves.toBe(0);
    expect(h.stdout).toEqual([
      'Tailscale',
      `  CLI:        ${APP_CLI_PATH}`,
      '  State:      Running',
      `  This Mac:   ${HOST}`,
      '  MagicDNS:   on',
      '  HTTPS:      certificates enabled',
      `  Bookshelf:  served at https://${HOST}/ → http://127.0.0.1:4380`,
      '  Server:     answering on http://127.0.0.1:4380',
    ]);
    expect(h.stderr).toEqual([]);
  });

  it('exits 1 with guidance when Bookshelf is not served', async () => {
    const h = harness({ healthy: false, status: statusJson({ CertDomains: null }) });
    await expect(main(['status'], h.deps)).resolves.toBe(1);
    expect(h.stdout).toContain('  HTTPS:      not enabled for the tailnet');
    expect(h.stdout).toContain('  Bookshelf:  not served (run `npm run tailscale:serve`)');
    expect(h.stdout).toContain('  Server:     not answering on http://127.0.0.1:4380');
    expect(h.stderr.join('\n')).toContain('Enable HTTPS');
  });

  it('skips the serve config while signed out', async () => {
    const h = harness({
      status: JSON.stringify({
        BackendState: 'NeedsLogin',
        CurrentTailnet: { MagicDNSEnabled: false },
      }),
    });
    await expect(main(['status'], h.deps)).resolves.toBe(1);
    expect(argsOf(h.calls)).toEqual(['status --json']);
    expect(h.stdout).toContain('  MagicDNS:   off');
    expect(h.stdout.some((line) => line.startsWith('  This Mac:'))).toBe(false);

    const unknown = harness({ status: JSON.stringify({ BackendState: 'NoState' }) });
    await main(['status'], unknown.deps);
    expect(unknown.stdout).toContain('  MagicDNS:   unknown');
  });
});

describe('off', () => {
  it('turns off only the HTTPS listener that serves Bookshelf', async () => {
    const h = harness({ served: true });
    await expect(main(['off'], h.deps)).resolves.toBe(0);
    expect(argsOf(h.calls)).toEqual(['serve status --json', 'serve --https=443 off']);
    expect(h.stdout[0]).toBe(
      `Stopped serving Bookshelf at https://${HOST}/. The server itself keeps running on http://127.0.0.1:4380.`,
    );
  });

  it('is a no-op when Bookshelf is not served', async () => {
    const h = harness();
    await expect(main(['off'], h.deps)).resolves.toBe(0);
    expect(argsOf(h.calls)).toEqual(['serve status --json']);
    expect(h.stdout[0]).toContain('nothing to turn off');
  });

  it('reports a failing off', async () => {
    const h = harness({
      served: true,
      override: (call) =>
        call.args[2] === 'off'
          ? { code: 1, stdout: '', stderr: 'error: access denied\n' }
          : undefined,
    });
    await expect(main(['off'], h.deps)).resolves.toBe(1);
    expect(h.stderr[0]).toBe(
      '`tailscale serve --https=443 off` failed (exit 1): error: access denied',
    );
  });
});

describe('systemTailscaleDeps', () => {
  it('describes this repo and machine', () => {
    const deps = systemTailscaleDeps();
    expect(deps.repoRoot).toBe(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''));
    expect(deps.isExecutable(process.execPath)).toBe(true);
  });
});

describe('command line', () => {
  it('runs as a script and prints usage (Tailscale untouched)', () => {
    const script = fileURLToPath(new URL('tailscale.ts', import.meta.url));
    const help = spawnSync(process.execPath, [script, 'help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/tailscale.ts <command>');
  });
});
