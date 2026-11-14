/**
 * Publishes Bookshelf on the user's tailnet over HTTPS with `tailscale serve`
 * (ADR 0002, SPEC §9):
 *
 *   node scripts/tailscale.ts serve   (npm run tailscale:serve)
 *   node scripts/tailscale.ts status  (npm run tailscale:status)
 *   node scripts/tailscale.ts off     (npm run tailscale:off)
 *
 * `serve` runs `tailscale serve --bg <PORT>`, which terminates HTTPS at
 * `https://<mac>.<tailnet>.ts.net` with a Tailscale certificate and proxies to
 * `http://127.0.0.1:<PORT>`; the configuration persists across restarts.
 * `off` removes only the HTTPS listener that serves Bookshelf
 * (`tailscale serve --https=<port> off`), leaving any other serve config alone.
 *
 * The CLI is found on PATH (`tailscale`, e.g. from Homebrew) or inside the
 * Mac app bundle. Before serving, the script checks that Tailscale is signed
 * in and that the tailnet has HTTPS certificates enabled, and explains how to
 * fix either.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ScriptError,
  checkHealth,
  consoleOutput,
  isExecutable,
  readDotEnv,
  resolveServerConfig,
  runCommand,
  serverUrl,
  type CommandRunner,
  type Output,
} from './runtime.ts';

/** The CLI inside the standalone and App Store Mac apps. */
export const APP_CLI_PATH = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
export const ADMIN_DNS_URL = 'https://login.tailscale.com/admin/dns';

/** Captured CLI calls must not hang if the Tailscale daemon is wedged. */
const CLI_TIMEOUT_MS = 15_000;

const USAGE = `Usage: node scripts/tailscale.ts <command>

Commands:
  serve   publish Bookshelf on your tailnet over HTTPS (tailscale serve --bg <PORT>)
  status  show Tailscale's state and the Bookshelf HTTPS address, if served
  off     stop serving Bookshelf on your tailnet`;

export const INSTALL_INSTRUCTIONS = `Tailscale is not installed (looked for \`tailscale\` on your PATH and ${APP_CLI_PATH}).

Install it on this Mac with one of:
  brew install --cask tailscale-app
  the Mac App Store (search for "Tailscale")
  https://tailscale.com/download/mac
Then open Tailscale, sign in, and run \`npm run tailscale:serve\` again.
Install Tailscale on your iPhone too and sign in to the same tailnet.
See README "Remote access with Tailscale".`;

export interface TailscaleDeps extends Output {
  repoRoot: string;
  homeDir: string;
  systemTimeZone: string;
  pathEnv: string | undefined;
  isExecutable: (path: string) => boolean;
  run: CommandRunner;
  fetch: typeof fetch;
}

/** The Tailscale CLI: `tailscale` on PATH first, then the Mac app's binary. */
export function findTailscale(
  pathEnv: string | undefined,
  executable: (path: string) => boolean,
): string | null {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir.startsWith('/')) continue;
    const candidate = join(dir, 'tailscale');
    if (executable(candidate)) return candidate;
  }
  return executable(APP_CLI_PATH) ? APP_CLI_PATH : null;
}

export interface TailscaleStatus {
  /** e.g. `Running`, `NeedsLogin`, `Stopped`, `Starting`, `NoState`. */
  backendState: string;
  /** This Mac's MagicDNS name without the trailing dot, when known. */
  dnsName: string | null;
  /** Names Tailscale can issue HTTPS certificates for; empty when HTTPS is off for the tailnet. */
  certDomains: string[];
  magicDnsEnabled: boolean | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads the fields we need from `tailscale status --json`. */
export function parseStatus(json: unknown): TailscaleStatus {
  const root = record(json);
  if (!root || typeof root['BackendState'] !== 'string') {
    throw new ScriptError('Unexpected output from `tailscale status --json`.');
  }
  const dnsName = record(root['Self'])?.['DNSName'];
  const certDomains = Array.isArray(root['CertDomains'])
    ? root['CertDomains'].filter((d): d is string => typeof d === 'string')
    : [];
  const magicDns = record(root['CurrentTailnet'])?.['MagicDNSEnabled'];
  return {
    backendState: root['BackendState'],
    dnsName: typeof dnsName === 'string' && dnsName !== '' ? dnsName.replace(/\.$/, '') : null,
    certDomains,
    magicDnsEnabled: typeof magicDns === 'boolean' ? magicDns : null,
  };
}

export interface ServeMapping {
  /** The HTTPS address Bookshelf is reachable at, ending in `/`. */
  url: string;
  /** The tailnet port of the HTTPS listener (443 unless customised). */
  httpsPort: number;
}

/**
 * Finds the `tailscale serve status --json` handler that proxies to the
 * Bookshelf server on `port`; null when Bookshelf is not served.
 */
export function findBookshelfMapping(json: unknown, port: number): ServeMapping | null {
  const web = record(record(json)?.['Web']);
  if (!web) return null;
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(/.*)?$`);
  for (const [hostPort, site] of Object.entries(web)) {
    const handlers = record(record(site)?.['Handlers']);
    if (!handlers) continue;
    for (const [mount, handler] of Object.entries(handlers)) {
      const proxy = record(handler)?.['Proxy'];
      if (typeof proxy !== 'string' || !target.test(proxy)) continue;
      const separator = hostPort.lastIndexOf(':');
      const host = separator === -1 ? hostPort : hostPort.slice(0, separator);
      const httpsPort = separator === -1 ? 443 : Number(hostPort.slice(separator + 1));
      const path = mount.endsWith('/') ? mount : `${mount}/`;
      return {
        url: `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}${path}`,
        httpsPort,
      };
    }
  }
  return null;
}

async function runJson(deps: TailscaleDeps, cli: string, args: string[]): Promise<unknown> {
  const result = await deps.run(cli, args, { timeoutMs: CLI_TIMEOUT_MS });
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
    throw new ScriptError(
      `\`tailscale ${args.join(' ')}\` failed (exit ${result.code})${detail ? `: ${detail}` : ''}. Is the Tailscale app running?`,
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new ScriptError(`Unexpected output from \`tailscale ${args.join(' ')}\`.`);
  }
}

function requireCli(deps: TailscaleDeps): string {
  const cli = findTailscale(deps.pathEnv, deps.isExecutable);
  if (!cli) throw new ScriptError(INSTALL_INSTRUCTIONS);
  return cli;
}

function port(deps: TailscaleDeps): number {
  return resolveServerConfig(deps.repoRoot, readDotEnv(deps.repoRoot), {
    homeDir: deps.homeDir,
    systemTimeZone: deps.systemTimeZone,
  }).port;
}

/** Why Tailscale cannot serve yet, as instructions; null when it can. */
export function readinessProblem(status: TailscaleStatus): string | null {
  switch (status.backendState) {
    case 'Running':
      break;
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return 'Tailscale is not signed in. Open the Tailscale app from the menu bar and sign in (use the same account on your iPhone), then try again.';
    case 'Stopped':
      return 'Tailscale is disconnected. Open the Tailscale app from the menu bar and connect, then try again.';
    default:
      return `Tailscale is not ready (state: ${status.backendState}). Open the Tailscale app, make sure it is connected, then try again.`;
  }
  if (status.certDomains.length === 0) {
    const steps = [
      'HTTPS certificates are not enabled for your tailnet, and the iPhone app needs HTTPS.',
      `In the Tailscale admin console (${ADMIN_DNS_URL}):`,
    ];
    if (status.magicDnsEnabled === false) steps.push('  1. Enable MagicDNS.');
    steps.push(
      `  ${status.magicDnsEnabled === false ? '2' : '1'}. Under "HTTPS Certificates", choose Enable HTTPS.`,
      'Then run `npm run tailscale:serve` again.',
    );
    return steps.join('\n');
  }
  return null;
}

async function serve(deps: TailscaleDeps): Promise<number> {
  const cli = requireCli(deps);
  const serverPort = port(deps);
  const status = parseStatus(await runJson(deps, cli, ['status', '--json']));
  const problem = readinessProblem(status);
  if (problem) throw new ScriptError(problem);

  const existing = findBookshelfMapping(
    await runJson(deps, cli, ['serve', 'status', '--json']),
    serverPort,
  );
  if (existing) {
    deps.out(`Tailscale already serves Bookshelf at ${existing.url}`);
    return 0;
  }
  if (!(await checkHealth(deps.fetch, serverPort))) {
    deps.err(
      `Note: Bookshelf is not answering on ${serverUrl(serverPort)} yet. Start it (\`npm run service:install\` or \`npm start\`); Tailscale will forward to it once it is up.`,
    );
  }
  deps.out(`Running: tailscale serve --bg ${serverPort}`);
  const result = await deps.run(cli, ['serve', '--bg', String(serverPort)], { inherit: true });
  if (result.code !== 0) {
    throw new ScriptError('`tailscale serve` failed; see the message above.');
  }
  const mapping = findBookshelfMapping(
    await runJson(deps, cli, ['serve', 'status', '--json']),
    serverPort,
  );
  if (!mapping) {
    throw new ScriptError(
      '`tailscale serve` finished but no HTTPS address for Bookshelf is configured. Check `tailscale serve status`.',
    );
  }
  deps.out(`Bookshelf is now on your tailnet at ${mapping.url}`);
  deps.out(
    'On your iPhone (Tailscale connected): open that address in Safari, then Share → Add to Home Screen.',
  );
  deps.out('The setting persists across restarts; `npm run tailscale:off` removes it.');
  return 0;
}

async function status(deps: TailscaleDeps): Promise<number> {
  const cli = requireCli(deps);
  const serverPort = port(deps);
  const state = parseStatus(await runJson(deps, cli, ['status', '--json']));
  deps.out('Tailscale');
  deps.out(`  CLI:        ${cli}`);
  deps.out(`  State:      ${state.backendState}`);
  if (state.dnsName) deps.out(`  This Mac:   ${state.dnsName}`);
  deps.out(
    `  MagicDNS:   ${state.magicDnsEnabled === null ? 'unknown' : state.magicDnsEnabled ? 'on' : 'off'}`,
  );
  deps.out(
    `  HTTPS:      ${state.certDomains.length > 0 ? 'certificates enabled' : 'not enabled for the tailnet'}`,
  );
  const mapping =
    state.backendState === 'Running'
      ? findBookshelfMapping(await runJson(deps, cli, ['serve', 'status', '--json']), serverPort)
      : null;
  deps.out(
    mapping
      ? `  Bookshelf:  served at ${mapping.url} → ${serverUrl(serverPort)}`
      : `  Bookshelf:  not served (run \`npm run tailscale:serve\`)`,
  );
  const health = await checkHealth(deps.fetch, serverPort);
  deps.out(
    `  Server:     ${health ? `answering on ${serverUrl(serverPort)}` : `not answering on ${serverUrl(serverPort)}`}`,
  );
  const problem = readinessProblem(state);
  if (problem) deps.err(problem);
  return mapping ? 0 : 1;
}

async function off(deps: TailscaleDeps): Promise<number> {
  const cli = requireCli(deps);
  const serverPort = port(deps);
  const mapping = findBookshelfMapping(
    await runJson(deps, cli, ['serve', 'status', '--json']),
    serverPort,
  );
  if (!mapping) {
    deps.out(`Tailscale is not serving Bookshelf (port ${serverPort}); nothing to turn off.`);
    return 0;
  }
  const result = await deps.run(cli, ['serve', `--https=${mapping.httpsPort}`, 'off'], {
    timeoutMs: CLI_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new ScriptError(
      `\`tailscale serve --https=${mapping.httpsPort} off\` failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  deps.out(
    `Stopped serving Bookshelf at ${mapping.url}. The server itself keeps running on ${serverUrl(serverPort)}.`,
  );
  return 0;
}

/** Runs one command; returns the process exit code (2 for usage errors). */
export async function main(argv: readonly string[], deps: TailscaleDeps): Promise<number> {
  const [command] = argv;
  try {
    switch (command) {
      case 'serve':
        return await serve(deps);
      case 'status':
        return await status(deps);
      case 'off':
        return await off(deps);
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

/** The real machine. */
export function systemTailscaleDeps(): TailscaleDeps {
  return {
    ...consoleOutput,
    repoRoot: fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''),
    homeDir: homedir(),
    systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pathEnv: process.env['PATH'],
    isExecutable,
    run: runCommand,
    fetch: globalThis.fetch,
  };
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), systemTailscaleDeps());
}
