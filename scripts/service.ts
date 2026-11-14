/**
 * Runs Bookshelf as a launchd agent on macOS (SPEC §9):
 *
 *   node scripts/service.ts install    (npm run service:install)
 *   node scripts/service.ts uninstall  (npm run service:uninstall)
 *   node scripts/service.ts status     (npm run service:status)
 *   node scripts/service.ts logs [-n N] [-f]   (npm run service:logs)
 *   node scripts/service.ts plist [--out FILE] (print the agent without installing)
 *
 * The agent is rendered from `ops/com.bookshelf.server.plist`, written to
 * `~/Library/LaunchAgents/com.bookshelf.server.plist` and loaded with
 * `launchctl bootstrap gui/<uid>`. It runs this repo's `server/index.ts` with
 * the absolute path of the Node binary that ran the install (via its stable
 * PATH symlink when there is one, see {@link stableNodePath}), so re-run the
 * install after moving the repo or switching Node installations.
 *
 * The server reads `.env` itself; the agent only adds `NODE_ENV=production`,
 * a `PATH`, and `BOOKSHELF_TZ` pinned to the Mac's timezone at install time
 * (unless `.env` sets it), so sessions keep their days when the Mac travels.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTimeZone } from '../shared/index.ts';
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
  type CommandRunner,
  type Output,
} from './runtime.ts';

export const LABEL = 'com.bookshelf.server';
export const TEMPLATE_PATH = fileURLToPath(new URL(`../ops/${LABEL}.plist`, import.meta.url));

/** How long install waits for the new server to answer `/api/health`. */
const HEALTH_ATTEMPTS = 30;
const HEALTH_INTERVAL_MS = 500;
/** How long install waits for a replaced agent to release the port. */
const RELEASE_ATTEMPTS = 10;

const USAGE = `Usage: node scripts/service.ts <command>

Commands:
  install            build the web app if needed, install and start the launchd agent
  uninstall          stop the agent and remove it (data and logs are kept)
  status             show whether the agent is installed, running and answering
  logs [-n N] [-f]   show the last N log lines (default 50); -f keeps following
  plist [--out FILE] print the agent definition (or write it to FILE) without installing`;

export interface ServiceDeps extends Output {
  repoRoot: string;
  homeDir: string;
  uid: number;
  /** Absolute path of the Node binary the agent runs. */
  nodePath: string;
  platform: NodeJS.Platform;
  systemTimeZone: string;
  run: CommandRunner;
  isPortInUse(port: number): Promise<boolean>;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  /** The plist template; defaults to the committed `ops/` file. */
  template?: string;
}

/** Where the agent's files live for a given repo, home and data directory. */
export interface ServicePaths {
  plistPath: string;
  serverEntry: string;
  webIndex: string;
  logsDir: string;
  stdoutPath: string;
  stderrPath: string;
}

/** The installed agent file: `~/Library/LaunchAgents/com.bookshelf.server.plist`. */
export function agentPlistPath(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function servicePaths(repoRoot: string, homeDir: string, dataDir: string): ServicePaths {
  const logsDir = join(dataDir, 'logs');
  return {
    plistPath: agentPlistPath(homeDir),
    serverEntry: join(repoRoot, 'server', 'index.ts'),
    webIndex: join(repoRoot, 'web', 'dist', 'index.html'),
    logsDir,
    stdoutPath: join(logsDir, 'bookshelf.log'),
    stderrPath: join(logsDir, 'bookshelf.err.log'),
  };
}

/**
 * The path the agent should use for Node. `process.execPath` is fully
 * resolved, which for Homebrew is a versioned Cellar directory that vanishes
 * on `brew upgrade`; prefer the first `node` on PATH (e.g.
 * `/opt/homebrew/bin/node`) when it is the same binary.
 */
export function stableNodePath(
  execPath: string,
  pathEnv: string | undefined,
  realpath: (path: string) => string = realpathSync,
  executable: (path: string) => boolean = isExecutable,
): string {
  const target = realpath(execPath);
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir.startsWith('/')) continue;
    const candidate = join(dir, 'node');
    try {
      if (executable(candidate) && realpath(candidate) === target) return candidate;
    } catch {
      // A broken symlink on PATH: try the next directory.
    }
  }
  return execPath;
}

/** Escapes text for an XML element or attribute. */
export function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlUnescape(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export interface PlistValues {
  nodePath: string;
  serverEntry: string;
  repoDir: string;
  stdoutPath: string;
  stderrPath: string;
  environment: Record<string, string>;
}

/** Fills the template's `{{PLACEHOLDERS}}`, escaping every value. */
export function renderPlist(template: string, values: PlistValues): string {
  const environment = Object.entries(values.environment)
    .map(
      ([name, value]) =>
        `\t\t<key>${xmlEscape(name)}</key>\n\t\t<string>${xmlEscape(value)}</string>`,
    )
    .join('\n');
  const replacements: Record<string, string> = {
    NODE_PATH: xmlEscape(values.nodePath),
    SERVER_ENTRY: xmlEscape(values.serverEntry),
    REPO_DIR: xmlEscape(values.repoDir),
    STDOUT_PATH: xmlEscape(values.stdoutPath),
    STDERR_PATH: xmlEscape(values.stderrPath),
    ENVIRONMENT: environment,
  };
  const used = new Set<string>();
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => {
    const replacement = replacements[name];
    if (replacement === undefined) throw new ScriptError(`Unknown plist placeholder ${match}`);
    used.add(name);
    return replacement;
  });
  const missing = Object.keys(replacements).filter((name) => !used.has(name));
  if (missing.length > 0) {
    throw new ScriptError(`The plist template is missing placeholders: ${missing.join(', ')}`);
  }
  return rendered;
}

/** The Node binary named by an installed agent, if it can be read. */
export function installedNodePath(plist: string): string | null {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist);
  return match?.[1] === undefined ? null : xmlUnescape(match[1]);
}

export interface AgentState {
  loaded: boolean;
  /** launchd's job state, e.g. `running` or `not running`. */
  state: string | null;
  pid: number | null;
  lastExitCode: string | null;
}

/** Parses `launchctl print gui/<uid>/<label>` (only the job's own, one-tab-indented fields). */
export function parseLaunchctlPrint(output: string): Omit<AgentState, 'loaded'> {
  const field = (name: string) => new RegExp(`^\\t${name} = (.+)$`, 'm').exec(output)?.[1] ?? null;
  const pid = field('pid');
  return {
    state: field('state'),
    pid: pid === null ? null : Number(pid),
    lastExitCode: field('last exit code'),
  };
}

function serviceTarget(deps: ServiceDeps): string {
  return `gui/${deps.uid}/${LABEL}`;
}

async function agentState(deps: ServiceDeps): Promise<AgentState> {
  const result = await deps.run('launchctl', ['print', serviceTarget(deps)]);
  if (result.code !== 0) return { loaded: false, state: null, pid: null, lastExitCode: null };
  return { loaded: true, ...parseLaunchctlPrint(result.stdout) };
}

async function bootout(deps: ServiceDeps): Promise<void> {
  const result = await deps.run('launchctl', ['bootout', serviceTarget(deps)]);
  if (result.code !== 0) {
    throw new ScriptError(
      `launchctl bootout failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

interface Resolved {
  port: number;
  paths: ServicePaths;
  environment: Record<string, string>;
  /** Where BOOKSHELF_TZ comes from, for the install summary. */
  timeZoneNote: string;
}

/** Resolves the agent's environment and paths from `.env` and the machine. */
function resolveService(deps: ServiceDeps): Resolved {
  const dotEnv = readDotEnv(deps.repoRoot);
  const environment: Record<string, string> = {};
  let timeZoneNote: string;
  const dotEnvTimeZone = dotEnv['BOOKSHELF_TZ']?.trim();
  if (dotEnvTimeZone) {
    timeZoneNote = `${dotEnvTimeZone} (from .env)`;
  } else {
    if (!isValidTimeZone(deps.systemTimeZone)) {
      throw new ScriptError(
        `The Mac's timezone "${deps.systemTimeZone}" is not a usable IANA timezone; set BOOKSHELF_TZ in .env`,
      );
    }
    environment['BOOKSHELF_TZ'] = deps.systemTimeZone;
    timeZoneNote = `${deps.systemTimeZone} (the Mac's timezone now; set BOOKSHELF_TZ in .env to change it)`;
  }
  environment['NODE_ENV'] = 'production';
  environment['PATH'] = `${dirname(deps.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  // Validate exactly what the agent's server will see: .env plus our variables.
  const config = resolveServerConfig(
    deps.repoRoot,
    { ...dotEnv, ...environment },
    { homeDir: deps.homeDir, systemTimeZone: deps.systemTimeZone },
  );
  return {
    port: config.port,
    paths: servicePaths(deps.repoRoot, deps.homeDir, config.dataDir),
    environment,
    timeZoneNote,
  };
}

function renderFor(deps: ServiceDeps, resolved: Resolved): string {
  return renderPlist(deps.template ?? readFileSync(TEMPLATE_PATH, 'utf8'), {
    nodePath: deps.nodePath,
    serverEntry: resolved.paths.serverEntry,
    repoDir: deps.repoRoot,
    stdoutPath: resolved.paths.stdoutPath,
    stderrPath: resolved.paths.stderrPath,
    environment: resolved.environment,
  });
}

async function ensureWebBuild(deps: ServiceDeps, paths: ServicePaths): Promise<void> {
  if (existsSync(paths.webIndex)) return;
  deps.out('The web app is not built yet; running `npm run build`…');
  const result = await deps.run('npm', ['run', 'build'], { cwd: deps.repoRoot, inherit: true });
  if (result.code !== 0 || !existsSync(paths.webIndex)) {
    throw new ScriptError(
      'Building the web app failed; fix the errors above and run the install again.',
    );
  }
}

/** Explains who holds the port, as precisely as we can tell. */
async function describePortUser(deps: ServiceDeps, port: number): Promise<string> {
  const health = await checkHealth(deps.fetch, port);
  if (health) {
    return `Another Bookshelf server (version ${health.version}) is already running on port ${port}, probably from \`npm start\` or \`npm run dev\`. Stop it, then run the install again.`;
  }
  const lsof = await deps.run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
  const pid = /^p(\d+)$/m.exec(lsof.stdout)?.[1];
  const command = /^c(.+)$/m.exec(lsof.stdout)?.[1];
  const who = pid && command ? ` by ${command} (pid ${pid})` : ' by another program';
  return `Port ${port} is already in use${who}. Stop that program or choose another port with PORT in .env, then run the install again.`;
}

async function waitForPortRelease(deps: ServiceDeps, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
    if (!(await deps.isPortInUse(port))) return true;
    await deps.sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}

async function install(deps: ServiceDeps): Promise<number> {
  if (deps.platform !== 'darwin') {
    throw new ScriptError('The Bookshelf service uses launchd and only runs on macOS.');
  }
  const resolved = resolveService(deps);
  const { paths, port } = resolved;
  await ensureWebBuild(deps, paths);

  const existing = await agentState(deps);
  if (existing.loaded) {
    deps.out('Stopping the installed Bookshelf service to replace it…');
    await bootout(deps);
    if (!(await waitForPortRelease(deps, port))) {
      throw new ScriptError(await describePortUser(deps, port));
    }
  } else if (await deps.isPortInUse(port)) {
    throw new ScriptError(await describePortUser(deps, port));
  }

  mkdirSync(dirname(paths.plistPath), { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.plistPath, renderFor(deps, resolved), { mode: 0o644 });
  const bootstrap = await deps.run('launchctl', ['bootstrap', `gui/${deps.uid}`, paths.plistPath]);
  if (bootstrap.code !== 0) {
    throw new ScriptError(
      `launchctl bootstrap failed (exit ${bootstrap.code}): ${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`,
    );
  }

  deps.out(`Installed ${paths.plistPath}`);
  deps.out(`  Node:     ${deps.nodePath}`);
  deps.out(`  Timezone: ${resolved.timeZoneNote}`);
  deps.out(`  Logs:     ${paths.logsDir}`);
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    const health = await checkHealth(deps.fetch, port);
    if (health) {
      deps.out(`Bookshelf ${health.version} is running at ${serverUrl(port)} and starts at login.`);
      deps.out('Next: `npm run tailscale:serve` to reach it from your iPhone over HTTPS.');
      return 0;
    }
    await deps.sleep(HEALTH_INTERVAL_MS);
  }
  deps.err(
    `The service is installed but the server is not answering on ${serverUrl(port)}. Check \`npm run service:logs\`.`,
  );
  return 1;
}

async function uninstall(deps: ServiceDeps): Promise<number> {
  // Deliberately independent of .env, so a broken configuration can still be uninstalled.
  const plistPath = agentPlistPath(deps.homeDir);
  const state = await agentState(deps);
  if (state.loaded) {
    await bootout(deps);
    deps.out('Stopped the Bookshelf service.');
  }
  const hadFile = existsSync(plistPath);
  if (hadFile) {
    rmSync(plistPath);
    deps.out(`Removed ${plistPath}`);
  }
  if (!state.loaded && !hadFile) {
    deps.out('The Bookshelf service is not installed; nothing to do.');
  }
  deps.out('Your data, backups and logs in BOOKSHELF_DATA_DIR are untouched.');
  return 0;
}

async function status(deps: ServiceDeps): Promise<number> {
  const { paths, port } = resolveService(deps);
  const installed = existsSync(paths.plistPath);
  deps.out('Bookshelf service');
  deps.out(`  Agent file: ${paths.plistPath} (${installed ? 'installed' : 'not installed'})`);
  if (installed) {
    const nodePath = installedNodePath(readFileSync(paths.plistPath, 'utf8'));
    if (nodePath && !existsSync(nodePath)) {
      deps.err(
        `  Warning: the agent runs ${nodePath}, which no longer exists. Run \`npm run service:install\` again.`,
      );
    }
  }
  const state = await agentState(deps);
  let launchd = 'not loaded';
  if (state.loaded) {
    launchd = state.state ?? 'loaded';
    if (state.pid !== null) launchd += ` (pid ${state.pid})`;
    if (state.lastExitCode !== null && state.state !== 'running') {
      launchd += `, last exit code ${state.lastExitCode}`;
    }
  }
  deps.out(`  launchd:    ${launchd}`);
  const health = await checkHealth(deps.fetch, port);
  deps.out(
    health
      ? `  Server:     answering at ${serverUrl(port)} (version ${health.version})`
      : `  Server:     not answering on ${serverUrl(port)}`,
  );
  deps.out(`  Logs:       ${paths.logsDir}`);
  return health ? 0 : 1;
}

export function parseLogsArgs(args: readonly string[]): { lines: number; follow: boolean } {
  let lines = 50;
  let follow = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (arg === '-n' || arg === '--lines') {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new ScriptError(`${arg} needs a positive whole number of lines`);
      }
      lines = value;
      i += 1;
    } else {
      throw new ScriptError(`Unknown option for logs: ${String(arg)}`);
    }
  }
  return { lines, follow };
}

async function logs(deps: ServiceDeps, args: readonly string[]): Promise<number> {
  const { lines, follow } = parseLogsArgs(args);
  const { paths } = resolveService(deps);
  const files = [paths.stdoutPath, paths.stderrPath].filter((file) => existsSync(file));
  if (files.length === 0) {
    deps.out(`No logs yet in ${paths.logsDir} (the service writes them once it has started).`);
    return 0;
  }
  const result = await deps.run(
    'tail',
    ['-n', String(lines), ...(follow ? ['-F'] : []), ...files],
    {
      inherit: true,
    },
  );
  return result.code;
}

function plist(deps: ServiceDeps, args: readonly string[]): number {
  let out: string | null = null;
  if (args.length > 0) {
    if (args[0] !== '--out' || args[1] === undefined || args.length > 2) {
      throw new ScriptError('Usage: node scripts/service.ts plist [--out FILE]');
    }
    out = args[1];
  }
  const rendered = renderFor(deps, resolveService(deps));
  if (out === null) {
    deps.out(rendered.trimEnd());
  } else {
    writeFileSync(out, rendered);
    deps.out(`Wrote ${out}`);
  }
  return 0;
}

/** Runs one command; returns the process exit code (2 for usage errors). */
export async function main(argv: readonly string[], deps: ServiceDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'install':
        return await install(deps);
      case 'uninstall':
        return await uninstall(deps);
      case 'status':
        return await status(deps);
      case 'logs':
        return await logs(deps, rest);
      case 'plist':
        return plist(deps, rest);
      case 'help':
      case '--help':
      case '-h':
        deps.out(USAGE);
        return 0;
      default:
        deps.err(command === undefined ? USAGE : `Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ScriptError) {
      deps.err(error.message);
      return 1;
    }
    throw error;
  }
}

/** The real machine: this repo, this user, this Node binary. */
export function systemServiceDeps(): ServiceDeps {
  return {
    ...consoleOutput,
    repoRoot: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''),
    homeDir: homedir(),
    uid: process.getuid?.() ?? 0,
    nodePath: stableNodePath(process.execPath, process.env['PATH']),
    platform: process.platform,
    systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    run: runCommand,
    isPortInUse: (port) => isPortInUse(port),
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), systemServiceDeps());
}
