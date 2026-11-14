import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  configSecrets,
  HOST,
  loadConfig,
  loadDotEnv,
  parseNotionId,
  systemContext,
  type ConfigContext,
} from './config.ts';

const ctx: ConfigContext = {
  homeDir: '/Users/reader',
  systemTimeZone: 'Europe/London',
  repoRoot: '/repo',
  version: '1.2.3',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({}, ctx)).toEqual({
      host: HOST,
      port: 4380,
      dataDir: '/Users/reader/Library/Application Support/Bookshelf',
      dbPath: '/Users/reader/Library/Application Support/Bookshelf/bookshelf.db',
      coversDir: '/Users/reader/Library/Application Support/Bookshelf/covers',
      backupsDir: '/Users/reader/Library/Application Support/Bookshelf/backups',
      timeZone: 'Europe/London',
      logLevel: 'info',
      googleBooksApiKey: null,
      notion: null,
      webDistDir: '/repo/web/dist',
      version: '1.2.3',
    });
  });

  it('always binds to loopback', () => {
    expect(loadConfig({ HOST: '0.0.0.0' }, ctx).host).toBe('127.0.0.1');
  });

  it('reads overrides, expanding ~ and resolving relative paths', () => {
    const config = loadConfig(
      {
        PORT: '5000',
        BOOKSHELF_DATA_DIR: '~/Books',
        BOOKSHELF_TZ: 'America/New_York',
        LOG_LEVEL: 'warn',
        GOOGLE_BOOKS_API_KEY: ' key ',
        NOTION_TOKEN: 'ntn_x',
        NOTION_PARENT_PAGE_ID:
          'https://www.notion.so/My-Books-0123456789abcdef0123456789abcdef?pvs=4',
      },
      ctx,
    );
    expect(config).toMatchObject({
      port: 5000,
      dataDir: '/Users/reader/Books',
      timeZone: 'America/New_York',
      logLevel: 'warn',
      googleBooksApiKey: 'key',
      notion: { token: 'ntn_x', parentPageId: '01234567-89ab-cdef-0123-456789abcdef' },
    });
    expect(loadConfig({ BOOKSHELF_DATA_DIR: '~' }, ctx).dataDir).toBe('/Users/reader');
    expect(loadConfig({ BOOKSHELF_DATA_DIR: 'data' }, ctx).dataDir).toBe('/repo/data');
    expect(loadConfig({ BOOKSHELF_DATA_DIR: '/srv/books' }, ctx).dataDir).toBe('/srv/books');
  });

  it('treats blank values as unset', () => {
    expect(
      loadConfig({ PORT: '', NOTION_TOKEN: '  ', NOTION_PARENT_PAGE_ID: '' }, ctx),
    ).toMatchObject({
      port: 4380,
      notion: null,
    });
  });

  it.each([
    [{ PORT: 'eighty' }, /PORT/],
    [{ PORT: '70000' }, /PORT/],
    [{ BOOKSHELF_TZ: 'Mars/Base' }, /BOOKSHELF_TZ: must be an IANA timezone/],
    [{ LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
    [{ NOTION_TOKEN: 'ntn_x' }, /must be set together/],
    [{ NOTION_TOKEN: 'ntn_x', NOTION_PARENT_PAGE_ID: 'not-an-id' }, /NOTION_PARENT_PAGE_ID/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig(env, ctx)).toThrow(ConfigError);
    expect(() => loadConfig(env, ctx)).toThrow(message);
  });

  it('rejects an unusable system timezone', () => {
    expect(() => loadConfig({}, { ...ctx, systemTimeZone: 'Nowhere/Land' })).toThrow(
      /system timezone/,
    );
  });
});

describe('parseNotionId', () => {
  it('normalises IDs and URLs', () => {
    expect(parseNotionId('0123456789abcdef0123456789abcdef')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef',
    );
    expect(parseNotionId('01234567-89AB-cdef-0123-456789abcdef')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef',
    );
    expect(parseNotionId('nothing here')).toBeNull();
  });
});

describe('loadDotEnv', () => {
  it('loads .env from the repo root when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookshelf-env-'));
    try {
      const loaded: string[] = [];
      const target = { loadEnvFile: (path: string) => loaded.push(path) };
      expect(loadDotEnv(dir, target)).toBe(false);
      writeFileSync(join(dir, '.env'), 'PORT=4999\n');
      expect(loadDotEnv(dir, target)).toBe(true);
      expect(loaded).toEqual([join(dir, '.env')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('helpers', () => {
  it('derives the system context', () => {
    const system = systemContext('/repo', '9.9.9');
    expect(system.repoRoot).toBe('/repo');
    expect(system.version).toBe('9.9.9');
    expect(system.homeDir.length).toBeGreaterThan(0);
    expect(system.systemTimeZone.length).toBeGreaterThan(0);
  });

  it('lists secrets to scrub', () => {
    expect(configSecrets(loadConfig({}, ctx))).toEqual([]);
    expect(
      configSecrets(
        loadConfig(
          {
            GOOGLE_BOOKS_API_KEY: 'g',
            NOTION_TOKEN: 'n',
            NOTION_PARENT_PAGE_ID: '0123456789abcdef0123456789abcdef',
          },
          ctx,
        ),
      ),
    ).toEqual(['g', 'n']);
  });
});
