/**
 * Bookpine CSV import from the command line (SPEC §8.1, §9):
 *
 *   npm run import:bookpine -- <file.csv> [--member <name or id>] [--dry-run] [--json]
 *
 * Runs the same preview/import as `POST /api/import/bookpine[/preview]`
 * against the database in the configured `BOOKSHELF_DATA_DIR` (`.env`, then
 * the environment, exactly as the server resolves it), into one family
 * member's shelf (ADR 0010): `--member` names them by name (any case) or id,
 * and defaults to the owner. `--dry-run` writes
 * nothing; a real import looks books up online, writes a pre-import snapshot
 * to `backups/` and applies everything in one transaction. It is safe to run
 * while the server is running (SQLite serialises the writes).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { BookpineReport } from '../shared/index.ts';
import { configSecrets } from '../server/config.ts';
import type { AppContext } from '../server/context.ts';
import { openDatabase } from '../server/db/database.ts';
import { migrate } from '../server/db/migrate.ts';
import { AppError } from '../server/http/errors.ts';
import { createLogger } from '../server/logger.ts';
import { findOwner, listMembers, type MemberRow } from '../server/repositories/members.ts';
import { importBookpine, previewBookpine } from '../server/services/bookpine.ts';
import { selfScope } from '../server/services/scope.ts';
import {
  consoleOutput,
  readDotEnv,
  resolveServerConfig,
  ScriptError,
  type MachineContext,
  type Output,
} from './runtime.ts';

export const USAGE = `Usage: npm run import:bookpine -- <bookpine-export.csv> [--member <name or id>] [--dry-run] [--json]

  --member   The family member whose shelf to import into (name or id; default: the owner)
  --dry-run  Show what the import would do without changing anything
  --json     Print the full report as JSON instead of a summary

Imports into the database in BOOKSHELF_DATA_DIR (from .env or the environment).`;

export interface OpenedContext {
  ctx: AppContext;
  close(): void;
}

export interface ImportDeps extends Output {
  /** Reads the CSV; throws a ScriptError when it cannot. */
  readFile(path: string): string;
  /** Opens (and migrates) the configured database. */
  open(): OpenedContext;
}

interface Options {
  file: string;
  /** Name or id of the member to import into; null for the owner. */
  member: string | null;
  dryRun: boolean;
  json: boolean;
}

type Parsed =
  { kind: 'run'; options: Options } | { kind: 'help' } | { kind: 'error'; message: string };

function parseArgs(argv: readonly string[]): Parsed {
  let file: string | null = null;
  let member: string | null = null;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '--member' || arg.startsWith('--member=')) {
      const value = arg === '--member' ? argv[(i += 1)] : arg.slice('--member='.length);
      if (!value?.trim()) {
        return { kind: 'error', message: 'Give a member name or id after --member.' };
      }
      member = value.trim();
    } else if (arg.startsWith('-')) return { kind: 'error', message: `Unknown option "${arg}".` };
    else if (file === null) file = arg;
    else return { kind: 'error', message: 'Give exactly one CSV file.' };
  }
  return file === null
    ? { kind: 'error', message: 'Give the Bookpine CSV export to import.' }
    : { kind: 'run', options: { file, member, dryRun, json } };
}

/**
 * The live member named by `wanted` (an id, or a name in any case), or the
 * owner when null. Throws a ScriptError when no single member matches.
 */
export function resolveMember(ctx: AppContext, wanted: string | null): MemberRow {
  if (wanted === null) {
    const owner = findOwner(ctx.db);
    if (!owner)
      throw new ScriptError(
        'No admin member found; give --member to choose whose shelf to import into.',
      );
    return owner;
  }
  const members = listMembers(ctx.db);
  const byId = members.find((member) => member.id === wanted);
  if (byId) return byId;
  const key = wanted.toLocaleLowerCase('en-GB');
  const named = members.filter((member) => member.name.toLocaleLowerCase('en-GB') === key);
  if (named.length === 1) return named[0] as MemberRow;
  if (named.length > 1) {
    throw new ScriptError(
      `More than one member is called "${wanted}"; give an id instead: ${named.map((m) => m.id).join(', ')}`,
    );
  }
  throw new ScriptError(
    `No member is called "${wanted}". Members: ${members.map((m) => m.name).join(', ')}`,
  );
}

function counts(
  label: string,
  c: { created: number; updated: number; unchanged: number; skipped: number },
): string {
  return `${label}: ${c.created} new, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skipped} skipped`;
}

/** A plain-text summary of an import report. */
export function formatReport(report: BookpineReport): string[] {
  const lines = [
    report.dryRun ? 'Dry run — nothing was changed.' : 'Import finished.',
    `Rows: ${report.rows}`,
    `${counts('Books', report.books)}, ${report.books.matched} linked to existing books`,
    counts('Formats', report.formats),
    counts('Reads', report.reads),
    `${counts('Sessions', report.sessions)} (${report.sessions.untimed} with unknown duration)`,
    counts('Notes', report.notes),
    `Tags created: ${report.tags.created === 0 ? 'none' : report.tags.names.join(', ')}`,
    `Fields kept as edited in Bookshelf: ${report.keptEdits}`,
    report.dryRun
      ? `Books to look up: ${report.enrichment.pending}`
      : `Lookups: ${report.enrichment.found} found, ${report.enrichment.notFound} not found, ${report.enrichment.failed} failed; covers: ${report.covers.cached} saved, ${report.covers.failed} failed`,
  ];
  if (report.merges.length > 0) {
    lines.push(`Merged editions (${report.merges.length}):`);
    for (const merge of report.merges) lines.push(`  ${merge.title} — ${merge.slugs.join(', ')}`);
  }
  if (report.warnings.length > 0) {
    lines.push(`Warnings (${report.warnings.length}):`);
    for (const warning of report.warnings) {
      lines.push(`  ${warning.slug ? `${warning.slug}: ` : ''}${warning.message}`);
    }
  }
  if (report.snapshot) lines.push(`Safety snapshot: backups/${report.snapshot}`);
  return lines;
}

export async function main(argv: readonly string[], deps: ImportDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    deps.out(USAGE);
    return 0;
  }
  if (parsed.kind === 'error') {
    deps.err(`${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  let opened: OpenedContext | null = null;
  try {
    const csv = deps.readFile(options.file);
    opened = deps.open();
    const { ctx } = opened;
    deps.err(`Data directory: ${ctx.config.dataDir}`);
    const member = resolveMember(ctx, options.member);
    deps.err(`Importing into ${member.name}’s shelf`);
    const scope = selfScope(member);
    const report = options.dryRun
      ? await previewBookpine(ctx, scope, csv)
      : await importBookpine(ctx, scope, csv, {
          onLookup: (done, total) => {
            deps.err(`Looking up book ${done + 1} of ${total}…`);
          },
        });
    if (options.json) deps.out(JSON.stringify(report, null, 2));
    else for (const line of formatReport(report)) deps.out(line);
    return 0;
  } catch (error) {
    if (error instanceof ScriptError || error instanceof AppError) {
      deps.err(error.message);
      return 1;
    }
    throw error;
  } finally {
    opened?.close();
  }
}

/**
 * The real machine: the server's configuration from `<repoRoot>/.env`
 * overridden by `env`, the network, the clock and timers.
 */
export function systemImportDeps(
  repoRoot: string,
  env: Record<string, string | undefined>,
  machine: MachineContext = {
    homeDir: homedir(),
    systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  output: Output = consoleOutput,
): ImportDeps {
  return {
    ...output,
    readFile(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch (error) {
        throw new ScriptError(
          `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    open() {
      const defined = Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const config = resolveServerConfig(
        repoRoot,
        { ...readDotEnv(repoRoot), ...defined },
        machine,
      );
      for (const dir of [config.dataDir, config.coversDir, config.backupsDir]) {
        mkdirSync(dir, { recursive: true });
      }
      const db = openDatabase(config.dbPath);
      migrate(db);
      const ctx: AppContext = {
        db,
        config,
        // Only problems are logged; the summary goes to stdout.
        logger: createLogger({
          level: 'warn',
          secrets: configSecrets(config),
          write: (line) => {
            output.err(line);
          },
        }),
        fetch: globalThis.fetch,
        now: () => new Date(),
        sleep: (ms) => delay(ms),
      };
      return {
        ctx,
        close: () => {
          db.close();
        },
      };
    },
  };
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  process.exitCode = await main(process.argv.slice(2), systemImportDeps(repoRoot, process.env));
}
