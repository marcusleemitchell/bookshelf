import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, RunOptions } from './runtime.ts';
import {
  LABEL,
  TEMPLATE_PATH,
  installedNodePath,
  main,
  parseLaunchctlPrint,
  parseLogsArgs,
  renderPlist,
  servicePaths,
  stableNodePath,
  systemServiceDeps,
  xmlEscape,
  type PlistValues,
  type ServiceDeps,
} from './service.ts';

// ---------------------------------------------------------------------------
// A strict reader for the XML property-list subset launchd agents use. It
// rejects unbalanced tags, unknown elements, stray text and bad entities, so
// a passing parse means the document is structurally a valid plist.

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

interface Token {
  kind: 'open' | 'close' | 'empty' | 'text';
  name: string;
  text: string;
}

function tokenise(body: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /<(\/?)([a-z]+)((?:\s+[a-z]+="[^"]*")*)\s*(\/?)>|([^<]+)|(<)/gy;
  for (const match of body.matchAll(pattern)) {
    if (match[6]) throw new Error(`Malformed markup at offset ${String(match.index)}`);
    const text = match[5];
    if (text !== undefined) {
      if (text.trim() === '') continue;
      if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(text)) throw new Error(`Bad entity in "${text}"`);
      tokens.push({ kind: 'text', name: '', text });
      continue;
    }
    const name = match[2] ?? '';
    const kind = match[1] ? 'close' : match[4] ? 'empty' : 'open';
    tokens.push({ kind, name, text: '' });
  }
  return tokens;
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function parsePlistXml(xml: string): PlistValue {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
  expect(xml).toContain(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  );
  const body = xml
    .replace(/^<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const tokens = tokenise(body);
  let index = 0;
  const next = (): Token => {
    const token = tokens[index];
    if (!token) throw new Error('Unexpected end of document');
    index += 1;
    return token;
  };
  const expectClose = (name: string) => {
    const token = next();
    if (token.kind !== 'close' || token.name !== name) throw new Error(`Expected </${name}>`);
  };
  const readText = (name: string): string => {
    const token = tokens[index];
    if (token?.kind === 'text') {
      index += 1;
      expectClose(name);
      return unescapeXml(token.text);
    }
    expectClose(name);
    return '';
  };
  const value = (): PlistValue => {
    const token = next();
    if (token.kind === 'empty' && (token.name === 'true' || token.name === 'false')) {
      return token.name === 'true';
    }
    if (token.kind !== 'open') throw new Error(`Unexpected ${token.kind} ${token.name}`);
    switch (token.name) {
      case 'string':
        return readText('string');
      case 'integer': {
        const text = readText('integer');
        if (!/^-?\d+$/.test(text)) throw new Error(`Bad integer ${text}`);
        return Number(text);
      }
      case 'array': {
        const items: PlistValue[] = [];
        while (tokens[index]?.kind !== 'close') items.push(value());
        expectClose('array');
        return items;
      }
      case 'dict': {
        const dict: Record<string, PlistValue> = {};
        while (tokens[index]?.kind !== 'close') {
          const key = next();
          if (key.kind !== 'open' || key.name !== 'key') throw new Error('Expected <key>');
          const name = readText('key');
          if (name in dict) throw new Error(`Duplicate key ${name}`);
          dict[name] = value();
        }
        expectClose('dict');
        return dict;
      }
      default:
        throw new Error(`Unknown element <${token.name}>`);
    }
  };
  const root = next();
  if (root.kind !== 'open' || root.name !== 'plist') throw new Error('Expected <plist>');
  const result = value();
  expectClose('plist');
  if (index !== tokens.length) throw new Error('Content after </plist>');
  return result;
}

// ---------------------------------------------------------------------------

const values: PlistValues = {
  nodePath: '/opt/homebrew/bin/node',
  serverEntry: '/Users/reader/Code & Books/bookshelf/server/index.ts',
  repoDir: '/Users/reader/Code & Books/bookshelf',
  stdoutPath: '/Users/reader/Library/Application Support/Bookshelf/logs/bookshelf.log',
  stderrPath: '/Users/reader/Library/Application Support/Bookshelf/logs/bookshelf.err.log',
  environment: { BOOKSHELF_TZ: 'Europe/London', NODE_ENV: 'production', PATH: '/usr/bin:/bin' },
};

const expectedAgent = {
  Label: 'com.bookshelf.server',
  ProgramArguments: [values.nodePath, values.serverEntry],
  WorkingDirectory: values.repoDir,
  EnvironmentVariables: values.environment,
  RunAtLoad: true,
  KeepAlive: { SuccessfulExit: false },
  ThrottleInterval: 30,
  StandardOutPath: values.stdoutPath,
  StandardErrorPath: values.stderrPath,
};

describe('xmlEscape', () => {
  it('escapes the five XML special characters', () => {
    expect(xmlEscape(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
});

describe('renderPlist', () => {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');

  it('renders the committed template into a valid launchd agent', () => {
    const xml = renderPlist(template, values);
    expect(xml).not.toMatch(/\{\{/);
    expect(xml).toContain('Code &amp; Books');
    expect(parsePlistXml(xml)).toEqual(expectedAgent);
  });

  it('omits variables that are not given', () => {
    const xml = renderPlist(template, { ...values, environment: { NODE_ENV: 'production' } });
    expect(parsePlistXml(xml)).toMatchObject({ EnvironmentVariables: { NODE_ENV: 'production' } });
  });

  it('refuses templates with unknown or missing placeholders', () => {
    expect(() => renderPlist(`${template}{{SURPRISE}}`, values)).toThrow(
      'Unknown plist placeholder {{SURPRISE}}',
    );
    expect(() => renderPlist(template.replace('{{STDERR_PATH}}', '/tmp/x'), values)).toThrow(
      'missing placeholders: STDERR_PATH',
    );
  });

  it('is rejected by the test parser when malformed', () => {
    const xml = renderPlist(template, values);
    expect(() => parsePlistXml(xml.replace('</array>', ''))).toThrow();
    expect(() => parsePlistXml(xml.replace('Code &amp; Books', 'Code & Books'))).toThrow(/entity/);
    expect(() => parsePlistXml(xml.replace('<true/>', '<maybe/>'))).toThrow();
    expect(() => parsePlistXml(xml.replace('<integer>30', '<integer>3x'))).toThrow(/integer/);
  });

  const plutil = '/usr/bin/plutil';
  it.skipIf(!existsSync(plutil))(
    'passes plutil -lint and converts to the expected structure',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'bookshelf-plist-'));
      try {
        const file = join(dir, `${LABEL}.plist`);
        writeFileSync(file, renderPlist(template, values));
        const lint = spawnSync(plutil, ['-lint', file], { encoding: 'utf8' });
        expect(lint.status, lint.stdout + lint.stderr).toBe(0);
        const json = spawnSync(plutil, ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
        expect(json.status).toBe(0);
        expect(JSON.parse(json.stdout)).toEqual(expectedAgent);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('parseLaunchctlPrint', () => {
  it('reads the job state, pid and last exit code, ignoring nested fields', () => {
    const output = [
      `gui/501/${LABEL} = {`,
      '\tactive count = 1',
      `\tpath = /Users/reader/Library/LaunchAgents/${LABEL}.plist`,
      '\tstate = running',
      '\tpid = 4242',
      '\tlast exit code = (never exited)',
      '\tendpoints = {',
      '\t\tstate = active',
      '\t}',
      '}',
    ].join('\n');
    expect(parseLaunchctlPrint(output)).toEqual({
      state: 'running',
      pid: 4242,
      lastExitCode: '(never exited)',
    });
    expect(parseLaunchctlPrint('\tstate = not running\n\tlast exit code = 1\n')).toEqual({
      state: 'not running',
      pid: null,
      lastExitCode: '1',
    });
  });
});

describe('installedNodePath', () => {
  it('reads the Node binary from an installed agent', () => {
    const xml = renderPlist(readFileSync(TEMPLATE_PATH, 'utf8'), {
      ...values,
      nodePath: '/Users/reader/.nvm/versions/node/v25.9.0/bin/node',
    });
    expect(installedNodePath(xml)).toBe('/Users/reader/.nvm/versions/node/v25.9.0/bin/node');
    expect(installedNodePath('<plist/>')).toBeNull();
  });
});

describe('stableNodePath', () => {
  const links: Record<string, string> = {
    '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/25.9.0/bin/node',
    '/opt/homebrew/Cellar/node/25.9.0/bin/node': '/opt/homebrew/Cellar/node/25.9.0/bin/node',
    '/usr/local/bin/node': '/usr/local/Cellar/node/24.0.0/bin/node',
  };
  const realpath = (path: string) => {
    const target = links[path];
    if (!target) throw new Error(`ENOENT ${path}`);
    return target;
  };
  const executable = (path: string) => path in links;

  it('prefers a stable PATH symlink to the same binary', () => {
    expect(
      stableNodePath(
        '/opt/homebrew/Cellar/node/25.9.0/bin/node',
        'relative/bin:/usr/local/bin:/missing:/opt/homebrew/bin:/usr/bin',
        realpath,
        executable,
      ),
    ).toBe('/opt/homebrew/bin/node');
  });

  it('falls back to the running binary', () => {
    expect(
      stableNodePath(
        '/opt/homebrew/Cellar/node/25.9.0/bin/node',
        '/usr/local/bin',
        realpath,
        executable,
      ),
    ).toBe('/opt/homebrew/Cellar/node/25.9.0/bin/node');
    expect(
      stableNodePath('/opt/homebrew/Cellar/node/25.9.0/bin/node', undefined, realpath, executable),
    ).toBe('/opt/homebrew/Cellar/node/25.9.0/bin/node');
  });

  it('skips broken symlinks', () => {
    expect(
      stableNodePath(
        '/opt/homebrew/Cellar/node/25.9.0/bin/node',
        '/broken:/opt/homebrew/bin',
        realpath,
        (path) => path === '/broken/node' || executable(path),
      ),
    ).toBe('/opt/homebrew/bin/node');
  });
});

describe('parseLogsArgs', () => {
  it('defaults to the last 50 lines without following', () => {
    expect(parseLogsArgs([])).toEqual({ lines: 50, follow: false });
  });
  it('accepts -n/--lines and -f/--follow', () => {
    expect(parseLogsArgs(['-n', '200', '-f'])).toEqual({ lines: 200, follow: true });
    expect(parseLogsArgs(['--follow', '--lines', '5'])).toEqual({ lines: 5, follow: true });
  });
  it('rejects bad values and unknown options', () => {
    expect(() => parseLogsArgs(['-n'])).toThrow('positive whole number');
    expect(() => parseLogsArgs(['-n', '0'])).toThrow('positive whole number');
    expect(() => parseLogsArgs(['--tail'])).toThrow('Unknown option for logs: --tail');
  });
});

// ---------------------------------------------------------------------------
// Command logic against temp directories, with launchctl, npm, lsof, tail,
// the port probe and the health check faked.

interface Call {
  command: string;
  args: readonly string[];
  options: RunOptions | undefined;
}

interface HarnessOptions {
  built?: boolean;
  dotEnv?: string;
  loaded?: boolean;
  platform?: NodeJS.Platform;
  systemTimeZone?: string;
  /** Something other than our agent holds the port. */
  foreignPort?: boolean;
  /** A foreign Bookshelf server answers health checks. */
  foreignBookshelf?: boolean;
  /** Our agent never becomes healthy. */
  unhealthy?: boolean;
  /** The port stays in use after our agent stops. */
  portStuck?: boolean;
  override?: (call: Call) => CommandResult | undefined;
}

const UID = 501;
const TARGET = `gui/${UID}/${LABEL}`;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bookshelf-service-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness(options: HarnessOptions = {}) {
  const repoRoot = join(root, 'repo');
  const homeDir = join(root, 'home');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const webIndex = join(repoRoot, 'web', 'dist', 'index.html');
  if (options.built !== false) {
    mkdirSync(join(repoRoot, 'web', 'dist'), { recursive: true });
    writeFileSync(webIndex, '<!doctype html>');
  }
  if (options.dotEnv !== undefined) writeFileSync(join(repoRoot, '.env'), options.dotEnv);

  let loaded = options.loaded ?? false;
  let running = loaded;
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  const ok = (stdoutText = ''): CommandResult => ({ code: 0, stdout: stdoutText, stderr: '' });

  const deps: ServiceDeps = {
    repoRoot,
    homeDir,
    uid: UID,
    nodePath: '/opt/homebrew/bin/node',
    platform: options.platform ?? 'darwin',
    systemTimeZone: options.systemTimeZone ?? 'Europe/London',
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    run: (command, args, runOptions) => {
      const call = { command, args, options: runOptions };
      calls.push(call);
      const overridden = options.override?.(call);
      if (overridden) return Promise.resolve(overridden);
      const key = `${command} ${args.join(' ')}`;
      if (key === `launchctl print ${TARGET}`) {
        return Promise.resolve(
          loaded
            ? ok(
                `${TARGET} = {\n\tstate = running\n\tpid = 777\n\tlast exit code = (never exited)\n}\n`,
              )
            : {
                code: 113,
                stdout: '',
                stderr: `Could not find service "${LABEL}" in domain for user gui: ${UID}`,
              },
        );
      }
      if (key === `launchctl bootout ${TARGET}`) {
        loaded = false;
        running = false;
        return Promise.resolve(ok());
      }
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        loaded = true;
        running = true;
        return Promise.resolve(ok());
      }
      if (key === 'npm run build') {
        mkdirSync(join(repoRoot, 'web', 'dist'), { recursive: true });
        writeFileSync(webIndex, '<!doctype html>');
        return Promise.resolve(ok());
      }
      if (command === 'lsof') return Promise.resolve({ code: 1, stdout: '', stderr: '' });
      if (command === 'tail') return Promise.resolve(ok());
      throw new Error(`Unexpected command in test: ${key}`);
    },
    isPortInUse: () =>
      Promise.resolve(
        Boolean(options.foreignPort) || running || (Boolean(options.portStuck) && !running),
      ),
    fetch: () => {
      const healthy = options.foreignBookshelf === true || (running && options.unhealthy !== true);
      return healthy
        ? Promise.resolve(
            Response.json({ ok: true, version: '0.1.0', dbPath: '/data/bookshelf.db' }),
          )
        : Promise.reject(new TypeError('fetch failed'));
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  const plistPath = join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const defaultLogs = join(homeDir, 'Library', 'Application Support', 'Bookshelf', 'logs');
  return { deps, calls, stdout, stderr, sleeps, plistPath, defaultLogs, repoRoot, homeDir };
}

const commandsOf = (calls: Call[]) => calls.map((c) => `${c.command} ${c.args.join(' ')}`);

describe('main', () => {
  it('prints usage for help, no command and unknown commands', async () => {
    const h = harness();
    await expect(main(['help'], h.deps)).resolves.toBe(0);
    expect(h.stdout.join('\n')).toContain('Usage: node scripts/service.ts <command>');
    await expect(main([], h.deps)).resolves.toBe(2);
    await expect(main(['restart'], h.deps)).resolves.toBe(2);
    expect(h.stderr.join('\n')).toContain('Unknown command "restart".');
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

describe('install', () => {
  it('writes the agent, bootstraps it and waits until the server answers', async () => {
    const h = harness();
    await expect(main(['install'], h.deps)).resolves.toBe(0);

    expect(commandsOf(h.calls)).toEqual([
      `launchctl print ${TARGET}`,
      `launchctl bootstrap gui/${UID} ${h.plistPath}`,
    ]);
    const agent = parsePlistXml(readFileSync(h.plistPath, 'utf8'));
    expect(agent).toEqual({
      ...expectedAgent,
      ProgramArguments: ['/opt/homebrew/bin/node', join(h.repoRoot, 'server', 'index.ts')],
      WorkingDirectory: h.repoRoot,
      EnvironmentVariables: {
        BOOKSHELF_TZ: 'Europe/London',
        NODE_ENV: 'production',
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      },
      StandardOutPath: join(h.defaultLogs, 'bookshelf.log'),
      StandardErrorPath: join(h.defaultLogs, 'bookshelf.err.log'),
    });
    expect(statSync(h.plistPath).mode & 0o777).toBe(0o644);
    expect(existsSync(h.defaultLogs)).toBe(true);
    const output = h.stdout.join('\n');
    expect(output).toContain(`Installed ${h.plistPath}`);
    expect(output).toContain("Europe/London (the Mac's timezone now");
    expect(output).toContain(
      'Bookshelf 0.1.0 is running at http://127.0.0.1:4380 and starts at login.',
    );
    expect(output).toContain('npm run tailscale:serve');
  });

  it('leaves BOOKSHELF_TZ to .env and follows its PORT and data directory', async () => {
    const h = harness({
      dotEnv: 'PORT=4390\nBOOKSHELF_TZ=America/New_York\nBOOKSHELF_DATA_DIR=~/BookshelfData\n',
    });
    await expect(main(['install'], h.deps)).resolves.toBe(0);
    const agent = parsePlistXml(readFileSync(h.plistPath, 'utf8')) as Record<string, PlistValue>;
    expect(agent['EnvironmentVariables']).toEqual({
      NODE_ENV: 'production',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    });
    expect(agent['StandardOutPath']).toBe(
      join(h.homeDir, 'BookshelfData', 'logs', 'bookshelf.log'),
    );
    expect(h.stdout.join('\n')).toContain('America/New_York (from .env)');
    expect(h.stdout.join('\n')).toContain('http://127.0.0.1:4390');
  });

  it('builds the web app first when web/dist is missing', async () => {
    const h = harness({ built: false });
    await expect(main(['install'], h.deps)).resolves.toBe(0);
    const build = h.calls.find((c) => c.command === 'npm');
    expect(build?.args).toEqual(['run', 'build']);
    expect(build?.options).toEqual({ cwd: h.repoRoot, inherit: true });
    expect(h.stdout[0]).toContain('The web app is not built yet');
  });

  it('stops when the build fails', async () => {
    const h = harness({
      built: false,
      override: (call) =>
        call.command === 'npm' ? { code: 1, stdout: '', stderr: 'tsc failed' } : undefined,
    });
    await expect(main(['install'], h.deps)).resolves.toBe(1);
    expect(h.stderr.join('\n')).toContain('Building the web app failed');
    expect(existsSync(h.plistPath)).toBe(false);
  });

  it('refuses when another program holds the port, naming it when lsof can', async () => {
    const h = harness({
      foreignPort: true,
      override: (call) =>
        call.command === 'lsof' ? { code: 0, stdout: 'p9876\ncpython3\n', stderr: '' } : undefined,
    });
    await expect(main(['install'], h.deps)).resolves.toBe(1);
    expect(h.stderr.join('\n')).toBe(
      'Port 4380 is already in use by python3 (pid 9876). Stop that program or choose another port with PORT in .env, then run the install again.',
    );
    expect(commandsOf(h.calls)).toContain('lsof -nP -iTCP:4380 -sTCP:LISTEN -Fpc');
    expect(h.calls.some((c) => c.args[0] === 'bootstrap')).toBe(false);
    expect(existsSync(h.plistPath)).toBe(false);
  });

  it('refuses with a generic message when the port user is unknown', async () => {
    const h = harness({ foreignPort: true });
    await expect(main(['install'], h.deps)).resolves.toBe(1);
    expect(h.stderr.join('\n')).toContain('Port 4380 is already in use by another program.');
  });

  it('refuses when a manually started Bookshelf server is running', async () => {
    const h = harness({ foreignPort: true, foreignBookshelf: true });
    await expect(main(['install'], h.deps)).resolves.toBe(1);
    expect(h.stderr.join('\n')).toContain(
      'Another Bookshelf server (version 0.1.0) is already running on port 4380',
    );
  });

  it('replaces an installed agent', async () => {
    const h = harness({ loaded: true });
    await expect(main(['install'], h.deps)).resolves.toBe(0);
    expect(commandsOf(h.calls)).toEqual([
      `launchctl print ${TARGET}`,
      `launchctl bootout ${TARGET}`,
      `launchctl bootstrap gui/${UID} ${h.plistPath}`,
    ]);
    expect(h.stdout[0]).toBe('Stopping the installed Bookshelf service to replace it…');
  });

  it('refuses when the port is still held after stopping the old agent', async () => {
    const h = harness({ loaded: true, portStuck: true });
    await expect(main(['install'], h.deps)).resolves.toBe(1);
    expect(h.sleeps).toHaveLength(10);
    expect(h.stderr.join('\n')).toContain('Port 4380 is already in use');
  });

  it('reports launchctl failures', async () => {
    const bootstrapFails = harness({
      override: (call) =>
        call.args[0] === 'bootstrap'
          ? { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }
          : undefined,
    });
    await expect(main(['install'], bootstrapFails.deps)).resolves.toBe(1);
    expect(bootstrapFails.stderr.join('\n')).toBe(
      'launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error',
    );

    const bootoutFails = harness({
      loaded: true,
      override: (call) =>
        call.args[0] === 'bootout' ? { code: 3, stdout: 'No such process', stderr: '' } : undefined,
    });
    await expect(main(['install'], bootoutFails.deps)).resolves.toBe(1);
    expect(bootoutFails.stderr.join('\n')).toBe(
      'launchctl bootout failed (exit 3): No such process',
    );
  });

  it('says where to look when the server never answers', async () => {
    const h = harness({ unhealthy: true });
    await expect(main(['install'], h.deps)).resolves.toBe(1);
    expect(h.sleeps).toHaveLength(30);
    expect(h.stderr.join('\n')).toContain('Check `npm run service:logs`');
  });

  it('only runs on macOS', async () => {
    const h = harness({ platform: 'linux' });
    await expect(main(['install'], h.deps)).resolves.toBe(1);
    expect(h.stderr.join('\n')).toContain('only runs on macOS');
    expect(h.calls).toEqual([]);
  });

  it('stops on invalid configuration or an unusable system timezone', async () => {
    const badEnv = harness({ dotEnv: 'PORT=99999\n' });
    await expect(main(['install'], badEnv.deps)).resolves.toBe(1);
    expect(badEnv.stderr.join('\n')).toContain('Invalid configuration: PORT');

    const badZone = harness({ systemTimeZone: 'Not/AZone' });
    await expect(main(['install'], badZone.deps)).resolves.toBe(1);
    expect(badZone.stderr.join('\n')).toContain('set BOOKSHELF_TZ in .env');
    expect(badZone.calls).toEqual([]);
  });
});

describe('uninstall', () => {
  it('stops the agent and removes its file', async () => {
    const h = harness();
    await main(['install'], h.deps);
    h.stdout.length = 0;
    await expect(main(['uninstall'], h.deps)).resolves.toBe(0);
    expect(commandsOf(h.calls).slice(-2)).toEqual([
      `launchctl print ${TARGET}`,
      `launchctl bootout ${TARGET}`,
    ]);
    expect(existsSync(h.plistPath)).toBe(false);
    expect(h.stdout).toEqual([
      'Stopped the Bookshelf service.',
      `Removed ${h.plistPath}`,
      'Your data, backups and logs in BOOKSHELF_DATA_DIR are untouched.',
    ]);
  });

  it('removes a leftover file for an agent that is not loaded, even with a broken .env', async () => {
    const h = harness({ dotEnv: 'PORT=nope\n' });
    mkdirSync(join(h.homeDir, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(h.plistPath, '<plist/>');
    await expect(main(['uninstall'], h.deps)).resolves.toBe(0);
    expect(existsSync(h.plistPath)).toBe(false);
    expect(commandsOf(h.calls)).toEqual([`launchctl print ${TARGET}`]);
  });

  it('is a no-op when nothing is installed', async () => {
    const h = harness();
    await expect(main(['uninstall'], h.deps)).resolves.toBe(0);
    expect(h.stdout[0]).toBe('The Bookshelf service is not installed; nothing to do.');
  });
});

describe('status', () => {
  it('reports an installed, running, answering service', async () => {
    const h = harness();
    await main(['install'], h.deps);
    h.stdout.length = 0;
    await expect(main(['status'], h.deps)).resolves.toBe(0);
    expect(h.stdout).toEqual([
      'Bookshelf service',
      `  Agent file: ${h.plistPath} (installed)`,
      '  launchd:    running (pid 777)',
      '  Server:     answering at http://127.0.0.1:4380 (version 0.1.0)',
      `  Logs:       ${h.defaultLogs}`,
    ]);
  });

  it('reports a missing service with exit code 1', async () => {
    const h = harness();
    await expect(main(['status'], h.deps)).resolves.toBe(1);
    expect(h.stdout).toContain(`  Agent file: ${h.plistPath} (not installed)`);
    expect(h.stdout).toContain('  launchd:    not loaded');
    expect(h.stdout).toContain('  Server:     not answering on http://127.0.0.1:4380');
  });

  it('shows the last exit code of a crashed agent and a vanished Node binary', async () => {
    const h = harness({
      loaded: true,
      unhealthy: true,
      override: (call) =>
        call.args[0] === 'print'
          ? {
              code: 0,
              stdout: `${TARGET} = {\n\tstate = not running\n\tlast exit code = 1\n}`,
              stderr: '',
            }
          : undefined,
    });
    mkdirSync(join(h.homeDir, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(
      h.plistPath,
      renderPlist(readFileSync(TEMPLATE_PATH, 'utf8'), {
        ...values,
        nodePath: join(root, 'gone', 'node'),
      }),
    );
    await expect(main(['status'], h.deps)).resolves.toBe(1);
    expect(h.stdout).toContain('  launchd:    not running, last exit code 1');
    expect(h.stderr.join('\n')).toContain(
      'which no longer exists. Run `npm run service:install` again.',
    );
  });

  it('describes a loaded agent without a state line', async () => {
    const h = harness({
      override: (call) =>
        call.args[0] === 'print' ? { code: 0, stdout: '{}', stderr: '' } : undefined,
    });
    await main(['status'], h.deps);
    expect(h.stdout).toContain('  launchd:    loaded');
  });
});

describe('logs', () => {
  it('says when there are no logs yet', async () => {
    const h = harness();
    await expect(main(['logs'], h.deps)).resolves.toBe(0);
    expect(h.stdout[0]).toContain(`No logs yet in ${h.defaultLogs}`);
    expect(h.calls).toEqual([]);
  });

  it('tails the existing log files, optionally following them', async () => {
    const h = harness({
      override: (call) =>
        call.command === 'tail' ? { code: 130, stdout: '', stderr: '' } : undefined,
    });
    mkdirSync(h.defaultLogs, { recursive: true });
    writeFileSync(join(h.defaultLogs, 'bookshelf.log'), '{"msg":"Bookshelf listening"}\n');
    await expect(main(['logs', '-n', '20', '-f'], h.deps)).resolves.toBe(130);
    expect(h.calls).toEqual([
      {
        command: 'tail',
        args: ['-n', '20', '-F', join(h.defaultLogs, 'bookshelf.log')],
        options: { inherit: true },
      },
    ]);
  });

  it('reports bad options', async () => {
    const h = harness();
    await expect(main(['logs', '-n', 'many'], h.deps)).resolves.toBe(1);
    expect(h.stderr[0]).toBe('-n needs a positive whole number of lines');
  });
});

describe('plist', () => {
  it('prints or writes the agent without touching launchd', async () => {
    const h = harness();
    await expect(main(['plist'], h.deps)).resolves.toBe(0);
    expect(parsePlistXml(`${h.stdout.join('\n')}\n`)).toMatchObject({ Label: LABEL });

    const out = join(root, 'agent.plist');
    await expect(main(['plist', '--out', out], h.deps)).resolves.toBe(0);
    expect(parsePlistXml(readFileSync(out, 'utf8'))).toMatchObject({ RunAtLoad: true });
    expect(h.calls).toEqual([]);
    expect(existsSync(h.plistPath)).toBe(false);
  });

  it('rejects other arguments', async () => {
    const h = harness();
    await expect(main(['plist', '--stdout'], h.deps)).resolves.toBe(1);
    await expect(main(['plist', '--out'], h.deps)).resolves.toBe(1);
    expect(h.stderr[0]).toBe('Usage: node scripts/service.ts plist [--out FILE]');
  });
});

describe('servicePaths', () => {
  it('puts the agent in LaunchAgents and the logs in the data directory', () => {
    expect(servicePaths('/repo', '/Users/reader', '/data')).toEqual({
      plistPath: `/Users/reader/Library/LaunchAgents/${LABEL}.plist`,
      serverEntry: '/repo/server/index.ts',
      webIndex: '/repo/web/dist/index.html',
      logsDir: '/data/logs',
      stdoutPath: '/data/logs/bookshelf.log',
      stderrPath: '/data/logs/bookshelf.err.log',
    });
  });
});

describe('systemServiceDeps', () => {
  it('describes this machine and repo', () => {
    const deps = systemServiceDeps();
    expect(deps.repoRoot).toBe(fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''));
    expect(existsSync(join(deps.repoRoot, 'server', 'index.ts'))).toBe(true);
    expect(deps.nodePath.startsWith('/')).toBe(true);
    expect(typeof deps.uid).toBe('number');
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });
});

describe('command line', () => {
  it('runs as a script and prints usage (no launchd involved)', () => {
    const script = fileURLToPath(new URL('service.ts', import.meta.url));
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: node scripts/service.ts <command>');
    const unknown = spawnSync(process.execPath, [script, 'nope'], { encoding: 'utf8' });
    expect(unknown.status).toBe(2);
  });
});
