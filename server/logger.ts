/**
 * Structured JSON-lines logger. Field names that look secret are redacted,
 * and known secret values are scrubbed from every string, so tokens and API
 * keys never reach the logs.
 */
import type { LogLevel } from './config.ts';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|secret|password|authori[sz]ation|api[-_]?key|cookie/i;
export const REDACTED = '[REDACTED]';

export interface LoggerOptions {
  level?: LogLevel | 'silent';
  secrets?: readonly string[];
  write?: (line: string) => void;
  now?: () => Date;
}

function scrub(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

function sanitise(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') return scrub(value, secrets);
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message, secrets) };
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 5) return '[Truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitise(item, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : sanitise(inner, secrets, depth + 1);
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const level = options.level ?? 'info';
  const secrets = options.secrets ?? [];
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? (() => new Date());
  const threshold = level === 'silent' ? Number.POSITIVE_INFINITY : LEVELS[level];

  const log = (lvl: LogLevel, message: string, fields?: LogFields) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = sanitise({ ...bound, ...fields }, secrets) as LogFields;
    write(
      JSON.stringify({
        time: now().toISOString(),
        level: lvl,
        msg: scrub(message, secrets),
        ...entry,
      }),
    );
  };

  return {
    debug: (message, fields) => {
      log('debug', message, fields);
    },
    info: (message, fields) => {
      log('info', message, fields);
    },
    warn: (message, fields) => {
      log('warn', message, fields);
    },
    error: (message, fields) => {
      log('error', message, fields);
    },
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}
