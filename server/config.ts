/**
 * Server configuration from environment variables (SPEC §2). Values come
 * from the process environment, optionally populated from the repo-root
 * `.env` file by {@link loadDotEnv}. Secrets are never logged.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { isValidTimeZone } from '../shared/index.ts';

/** The only interface the server listens on; remote access is via `tailscale serve`. */
export const HOST = '127.0.0.1';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface NotionConfig {
  token: string;
  /** Dashed UUID form of the parent page ID. */
  parentPageId: string;
}

export interface Config {
  host: typeof HOST;
  port: number;
  dataDir: string;
  dbPath: string;
  coversDir: string;
  backupsDir: string;
  timeZone: string;
  logLevel: LogLevel;
  googleBooksApiKey: string | null;
  notion: NotionConfig | null;
  /** Built web app served in production (may not exist in development). */
  webDistDir: string;
  version: string;
}

export interface ConfigContext {
  homeDir: string;
  systemTimeZone: string;
  repoRoot: string;
  version: string;
}

/** Converts a Notion page ID or page URL into a dashed UUID; null when none is found. */
export function parseNotionId(input: string): string | null {
  const compact = input.replace(/-/g, '');
  const matches = compact.match(/[0-9a-f]{32}/gi);
  const hex = matches?.at(-1)?.toLowerCase();
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const optional = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const envSchema = z
  .object({
    PORT: optional
      .transform((value) => (value === undefined ? undefined : Number(value)))
      .pipe(z.int().min(1).max(65_535).optional()),
    BOOKSHELF_DATA_DIR: optional,
    BOOKSHELF_TZ: optional.pipe(
      z
        .string()
        .refine(isValidTimeZone, { message: 'must be an IANA timezone, e.g. Europe/London' })
        .optional(),
    ),
    LOG_LEVEL: optional.pipe(z.enum(['debug', 'info', 'warn', 'error']).optional()),
    GOOGLE_BOOKS_API_KEY: optional,
    NOTION_TOKEN: optional,
    NOTION_PARENT_PAGE_ID: optional.pipe(
      z
        .string()
        .refine((value) => parseNotionId(value) !== null, {
          message: 'must be a Notion page ID or page URL',
        })
        .optional(),
    ),
  })
  .refine((env) => (env.NOTION_TOKEN === undefined) === (env.NOTION_PARENT_PAGE_ID === undefined), {
    message: 'NOTION_TOKEN and NOTION_PARENT_PAGE_ID must be set together',
    path: ['NOTION_TOKEN'],
  });

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return join(homeDir, path.slice(2));
  return path;
}

/** Validates the environment and resolves paths. Throws {@link ConfigError} on invalid values. */
export function loadConfig(env: Record<string, string | undefined>, ctx: ConfigContext): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const values = parsed.data;
  const rawDataDir = values.BOOKSHELF_DATA_DIR
    ? expandHome(values.BOOKSHELF_DATA_DIR, ctx.homeDir)
    : join(ctx.homeDir, 'Library', 'Application Support', 'Bookshelf');
  const dataDir = isAbsolute(rawDataDir) ? rawDataDir : resolve(ctx.repoRoot, rawDataDir);
  const timeZone = values.BOOKSHELF_TZ ?? ctx.systemTimeZone;
  if (!isValidTimeZone(timeZone)) {
    throw new ConfigError(`Invalid configuration: system timezone "${timeZone}" is not usable`);
  }
  const notion =
    values.NOTION_TOKEN && values.NOTION_PARENT_PAGE_ID
      ? {
          token: values.NOTION_TOKEN,
          parentPageId: parseNotionId(values.NOTION_PARENT_PAGE_ID) as string,
        }
      : null;
  return {
    host: HOST,
    port: values.PORT ?? 4380,
    dataDir,
    dbPath: join(dataDir, 'bookshelf.db'),
    coversDir: join(dataDir, 'covers'),
    backupsDir: join(dataDir, 'backups'),
    timeZone,
    logLevel: values.LOG_LEVEL ?? 'info',
    googleBooksApiKey: values.GOOGLE_BOOKS_API_KEY ?? null,
    notion,
    webDistDir: join(ctx.repoRoot, 'web', 'dist'),
    version: ctx.version,
  };
}

/** Loads `<repoRoot>/.env` into `process.env` when present (existing variables win). */
export function loadDotEnv(
  repoRoot: string,
  target: { loadEnvFile(path: string): void } = process,
): boolean {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) return false;
  target.loadEnvFile(path);
  return true;
}

/** Defaults derived from the running machine. */
export function systemContext(repoRoot: string, version: string): ConfigContext {
  return {
    homeDir: homedir(),
    systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    repoRoot,
    version,
  };
}

/** Secret values to scrub from logs. */
export function configSecrets(config: Config): string[] {
  return [config.googleBooksApiKey, config.notion?.token].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}
