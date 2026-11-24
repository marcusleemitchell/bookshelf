import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bookpineReportSchema } from '../shared/index.ts';
import { all } from '../server/db/database.ts';
import { createTestEnv, json, type TestEnv } from '../server/test/helpers.ts';
import { formatReport, main, systemImportDeps, USAGE, type ImportDeps } from './import-bookpine.ts';
import { ScriptError } from './runtime.ts';

const FIXTURE_PATH = new URL('../server/test/fixtures/bookpine-export.csv', import.meta.url);
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

let env: TestEnv;
let out: string[];
let err: string[];
let closed: number;

function deps(overrides: Partial<ImportDeps> = {}): ImportDeps {
  return {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: (path) => {
      if (path !== 'export.csv') throw new ScriptError(`Cannot read ${path}: ENOENT`);
      return FIXTURE;
    },
    open: () => ({
      ctx: env.ctx,
      close: () => {
        closed += 1;
      },
    }),
    ...overrides,
  };
}

function count(table: string): number {
  return all<{ n: number }>(env.ctx.db, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? -1;
}

beforeEach(() => {
  env = createTestEnv();
  env.fetchMock.on(
    () => true,
    () => json({}),
  );
  out = [];
  err = [];
  closed = 0;
});

afterEach(() => {
  env.cleanup();
});

describe('import:bookpine CLI', () => {
  it('previews with --dry-run without changing anything', async () => {
    expect(await main(['export.csv', '--dry-run'], deps())).toBe(0);
    expect(count('books')).toBe(0);
    expect(out[0]).toBe('Dry run — nothing was changed.');
    expect(out).toContain(
      'Books: 16 new, 0 updated, 0 unchanged, 0 skipped, 0 linked to existing books',
    );
    expect(out).toContain(
      'Sessions: 29 new, 0 updated, 0 unchanged, 0 skipped (29 with unknown duration)',
    );
    expect(out).toContain('Books to look up: 16');
    expect(out).toContain('Merged editions (4):');
    expect(out).toContain('  copper-and-thyme-1019: Ignored the invalid ISBN-13 "9780000000000"');
    expect(err[0]).toBe(`Data directory: ${env.ctx.config.dataDir}`);
    expect(closed).toBe(1);
  });

  it('imports, reporting lookup progress, and prints JSON on request', async () => {
    expect(await main(['--json', 'export.csv'], deps())).toBe(0);
    expect(count('books')).toBe(16);
    const report = bookpineReportSchema.parse(JSON.parse(out.join('\n')));
    expect(report).toMatchObject({ dryRun: false, books: { created: 16 } });
    expect(err).toContain('Looking up book 1 of 16…');
    expect(err).toContain('Looking up book 16 of 16…');
    out = [];
    expect(await main(['export.csv'], deps())).toBe(0);
    expect(out[0]).toBe('Import finished.');
    expect(out).toContain(
      'Books: 0 new, 0 updated, 16 unchanged, 0 skipped, 0 linked to existing books',
    );
    expect(out.find((line) => line.startsWith('Lookups: '))).toMatch(/covers: 0 saved, 0 failed$/);
    expect(out.at(-1)).toMatch(/^Safety snapshot: backups\/bookshelf-pre-import-/);
  });

  it('imports into the member named by --member (name in any case, or id), else the owner', async () => {
    const jo = env.addMember({ name: 'Jo' });
    const shelf = (memberId: string) =>
      all<{ n: number }>(
        env.ctx.db,
        'SELECT COUNT(*) AS n FROM shelf_entries WHERE member_id = ? AND deleted_at IS NULL',
        [memberId],
      )[0]?.n;
    expect(await main(['export.csv', '--member', 'jo'], deps())).toBe(0);
    expect(err).toContain('Importing into Jo’s shelf');
    expect(shelf(jo.member.id)).toBe(16);
    expect(shelf(env.owner.id)).toBe(0);
    expect(await main(['export.csv', `--member=${jo.member.id}`, '--dry-run'], deps())).toBe(0);
    expect(out).toContain(
      'Books: 0 new, 0 updated, 16 unchanged, 0 skipped, 0 linked to existing books',
    );
    expect(await main(['export.csv'], deps())).toBe(0);
    expect(err).toContain('Importing into Owner’s shelf');
    expect(shelf(env.owner.id)).toBe(16);
  });

  it('refuses an unknown, ambiguous or missing --member', async () => {
    env.addMember({ name: 'Sam' });
    env.addMember({ name: 'sam', role: 'child' });
    expect(await main(['export.csv', '--member', 'Robin'], deps())).toBe(1);
    expect(err.at(-1)).toBe('No member is called "Robin". Members: Owner, Sam, sam');
    expect(await main(['export.csv', '--member', 'SAM'], deps())).toBe(1);
    expect(err.at(-1)).toMatch(/^More than one member is called "SAM"; give an id instead: /);
    expect(await main(['export.csv', '--member'], deps())).toBe(2);
    expect(err.at(-1)).toContain('Give a member name or id after --member.');
    expect(count('shelf_entries')).toBe(0);
    env.ctx.db.exec('UPDATE members SET is_admin = 0');
    expect(await main(['export.csv'], deps())).toBe(1);
    expect(err.at(-1)).toBe(
      'No admin member found; give --member to choose whose shelf to import into.',
    );
  });

  it('explains usage, bad arguments, unreadable files and invalid exports', async () => {
    expect(await main(['--help'], deps())).toBe(0);
    expect(out).toEqual([USAGE]);
    expect(await main([], deps())).toBe(2);
    expect(err.at(-1)).toContain('Give the Bookpine CSV export to import.');
    expect(await main(['a.csv', 'b.csv'], deps())).toBe(2);
    expect(err.at(-1)).toContain('Give exactly one CSV file.');
    expect(await main(['export.csv', '--force'], deps())).toBe(2);
    expect(err.at(-1)).toContain('Unknown option "--force".');
    expect(await main(['missing.csv'], deps())).toBe(1);
    expect(err.at(-1)).toBe('Cannot read missing.csv: ENOENT');
    expect(closed).toBe(0);
    expect(await main(['export.csv'], deps({ readFile: () => 'title\nDune\n' }))).toBe(1);
    expect(err.at(-1)).toMatch(/^This is not a Bookpine export/);
    expect(closed).toBe(1);
    await expect(
      main(
        ['export.csv'],
        deps({
          open: () => {
            throw new Error('disk on fire');
          },
        }),
      ),
    ).rejects.toThrow('disk on fire');
  });

  it('formats a report without merges, warnings or snapshot', () => {
    const lines = formatReport(
      bookpineReportSchema.parse({
        dryRun: false,
        rows: 1,
        books: { created: 1, updated: 0, unchanged: 0, skipped: 0, matched: 0 },
        merges: [],
        formats: { created: 1, updated: 0, unchanged: 0, skipped: 0 },
        reads: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
        sessions: { created: 0, updated: 0, unchanged: 0, skipped: 0, untimed: 0 },
        notes: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
        tags: { created: 1, names: ['owned'] },
        keptEdits: 0,
        enrichment: { pending: 0, found: 1, notFound: 0, failed: 0 },
        covers: { cached: 1, failed: 0 },
        warnings: [{ slug: null, message: 'File-level note' }],
        snapshot: null,
      }),
    );
    expect(lines).toContain('Tags created: owned');
    expect(lines).toContain('  File-level note');
    expect(lines.some((line) => line.startsWith('Safety snapshot'))).toBe(false);
  });
});

describe('systemImportDeps', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bookshelf-cli-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('opens and migrates the database in BOOKSHELF_DATA_DIR, with the environment over .env', () => {
    const dataDir = join(root, 'data');
    writeFileSync(
      join(root, '.env'),
      `BOOKSHELF_DATA_DIR=${join(root, 'from-dotenv')}\nBOOKSHELF_TZ=Europe/Paris\n`,
    );
    const lines: string[] = [];
    const real = systemImportDeps(
      root,
      { BOOKSHELF_DATA_DIR: dataDir, UNSET: undefined },
      { homeDir: root, systemTimeZone: 'UTC' },
      { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    );
    const opened = real.open();
    expect(opened.ctx.config.dataDir).toBe(dataDir);
    expect(opened.ctx.config.timeZone).toBe('Europe/Paris');
    expect(existsSync(join(dataDir, 'bookshelf.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'backups'))).toBe(true);
    expect(existsSync(join(root, 'from-dotenv'))).toBe(false);
    expect(all(opened.ctx.db, 'SELECT * FROM import_links')).toEqual([]);
    opened.ctx.logger.info('quiet');
    opened.ctx.logger.warn('shown');
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(['shown']);
    expect(opened.ctx.now()).toBeInstanceOf(Date);
    opened.close();
    expect(opened.ctx.db.isOpen).toBe(false);
  });

  it('reads the CSV and reports unreadable files and invalid configuration', async () => {
    const real = systemImportDeps(root, { BOOKSHELF_DATA_DIR: join(root, 'd') });
    expect(real.readFile(new URL(FIXTURE_PATH).pathname)).toBe(FIXTURE);
    expect(() => real.readFile(join(root, 'nope.csv'))).toThrow(/^Cannot read .*nope\.csv: ENOENT/);
    const broken = systemImportDeps(root, { BOOKSHELF_DATA_DIR: join(root, 'd'), PORT: 'abc' });
    expect(() => broken.open()).toThrow(ScriptError);
    const opened = real.open();
    await expect(opened.ctx.sleep(1)).resolves.toBeUndefined();
    opened.close();
  });
});
