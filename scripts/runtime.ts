/**
 * Shared plumbing for the operations scripts (`scripts/service.ts` and
 * `scripts/tailscale.ts`): running external commands, resolving the server
 * configuration exactly as the server will see it, and probing a running
 * server. Uses Node built-ins plus the server's own config module, so the
 * port and data directory are resolved by the same code (and validation) as
 * `server/index.ts`. No third-party packages.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { HOST, loadConfig, type Config } from '../server/config.ts';
import { healthResponseSchema, type HealthResponse } from '../shared/index.ts';

/** A failure the scripts report to the user as a plain message (exit code 1). */
export class ScriptError extends Error {
  override readonly name = 'ScriptError';
}

export interface CommandResult {
  /** Exit code; 127 when the command could not be started, 1 when killed by a signal. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Connect the child to this terminal (output shown live, prompts answerable); nothing is captured. */
  inherit?: boolean;
  /** Kill the child after this many milliseconds. */
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandResult>;

/** Runs a command without a shell (arguments are never interpreted). */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export const consoleOutput: Output = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** True when `path` is an existing file this process may execute. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Variables from `<repoRoot>/.env`, parsed like the server's
 * `process.loadEnvFile` does; empty when there is no file.
 */
export function readDotEnv(repoRoot: string): Record<string, string> {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export interface MachineContext {
  homeDir: string;
  systemTimeZone: string;
}

/**
 * The configuration a server started from `repoRoot` sees, given `env`
 * (normally `.env` plus anything the launchd agent sets). Invalid values
 * throw a {@link ScriptError} carrying the server's own message.
 */
export function resolveServerConfig(
  repoRoot: string,
  env: Record<string, string>,
  machine: MachineContext,
): Config {
  try {
    // The version is only reported by /api/health; the scripts never use it.
    return loadConfig(env, { ...machine, repoRoot, version: 'n/a' });
  } catch (error) {
    throw new ScriptError(error instanceof Error ? error.message : String(error));
  }
}

/** The loopback URL of a server on `port`. */
export function serverUrl(port: number): string {
  return `http://${HOST}:${port}`;
}

/** Asks a server on `port` for `/api/health`; null when nothing healthy answers in time. */
export async function checkHealth(
  fetchImpl: typeof fetch,
  port: number,
  timeoutMs = 2000,
): Promise<HealthResponse | null> {
  try {
    const response = await fetchImpl(`${serverUrl(port)}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const parsed = healthResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function canConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, HOST, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * True when something already listens on (or holds) `127.0.0.1:port`: it
 * accepts connections, or the address cannot be bound.
 */
export async function isPortInUse(port: number, timeoutMs = 1000): Promise<boolean> {
  if (await canConnect(port, timeoutMs)) return true;
  return !(await canListen(port));
}
