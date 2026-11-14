/**
 * Settings (SPEC §6.8): goals, tags, backup (JSON export via share sheet or
 * download, JSON import, Notion sync and status), the Bookpine import
 * (pick CSV → preview → confirm → result), server status and the offline
 * outbox (pending / failed changes, retry and discard).
 */
import { useEffect, useState } from 'react';
import {
  backupEnvelopeSchema,
  formatDate,
  goalListSchema,
  healthResponseSchema,
  localDateKey,
  notionStatusSchema,
  tagListSchema,
  type BackupEnvelope,
  type BackupImportResponse,
  type BookpineReport,
  type GoalKind,
  type GoalWithProgress,
  type NotionRunResult,
  type Tag,
} from '../../../shared/index.ts';
import { errorMessage } from '../api/client.ts';
import {
  useAction,
  useOutboxCounts,
  useReachable,
  useResource,
  useServices,
} from '../app/hooks.ts';
import { invalidate, syncNow } from '../app/services.ts';
import { ActionError, ResourceView, ScreenHeader } from '../components/ui.tsx';
import { todayKey } from '../lib/dates.ts';
import { readFileText, saveTextFile } from '../lib/files.ts';
import { GOAL_LABELS, plural } from '../lib/labels.ts';
import { cacheKeys } from '../offline/cache.ts';
import type { OutboxRecord } from '../offline/db.ts';

export function Settings() {
  return (
    <>
      <ScreenHeader title="Settings" />
      <div className="stack">
        <GoalsSection />
        <TagsSection />
        <BackupSection />
        <BookpineSection />
        <NotionSection />
        <ServerSection />
        <OutboxSection />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Goals

const GOAL_KINDS: readonly GoalKind[] = ['books_per_year', 'pages_per_year', 'minutes_per_day'];

function GoalsSection() {
  const services = useServices();
  const year = Number(todayKey(services.now(), services.timeZone).slice(0, 4));
  const goals = useResource(cacheKeys.goals, goalListSchema, (api) => api.listGoals());
  return (
    <section className="section" aria-labelledby="settings-goals">
      <h2 id="settings-goals">Goals</h2>
      <ResourceView resource={goals} loadingLabel="Loading goals…">
        {(list) => (
          <div className="card stack">
            {GOAL_KINDS.map((kind) => {
              const goalYear = kind === 'minutes_per_day' ? null : year;
              const existing = list.find((g) => g.kind === kind && g.year === goalYear);
              return (
                <GoalEditor
                  key={`${kind}-${existing?.id ?? 'new'}`}
                  kind={kind}
                  year={goalYear}
                  existing={existing}
                />
              );
            })}
          </div>
        )}
      </ResourceView>
    </section>
  );
}

function GoalEditor({
  kind,
  year,
  existing,
}: {
  kind: GoalKind;
  year: number | null;
  existing: GoalWithProgress | undefined;
}) {
  const services = useServices();
  const [target, setTarget] = useState(existing ? String(existing.target) : '');
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const id = `goal-${kind}`;
  const label =
    year === null
      ? GOAL_LABELS[kind]
      : GOAL_LABELS[kind].replace('this year', `in ${String(year)}`);
  const value = Number(target);
  const valid = Number.isInteger(value) && value > 0;
  return (
    <form
      className="stack-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        setMessage(null);
        run(async () => {
          const { created } = await services.api.putGoal(existing?.id ?? services.newId(), {
            kind,
            year,
            target: value,
          });
          setMessage(created ? 'Goal set.' : 'Goal updated.');
          invalidate(services);
        });
      }}
    >
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            placeholder="No goal"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
            }}
          />
          <button type="submit" className="btn btn-small" disabled={busy || !valid}>
            Save
          </button>
          {existing && (
            <button
              type="button"
              className="btn btn-ghost btn-small"
              disabled={busy}
              onClick={() => {
                setMessage(null);
                run(async () => {
                  await services.api.deleteGoal(existing.id);
                  setTarget('');
                  setMessage('Goal removed.');
                  invalidate(services);
                });
              }}
            >
              Remove
            </button>
          )}
        </div>
        {existing && (
          <span className="field-hint">
            Progress: {Math.round(existing.current)} of {existing.target}
          </span>
        )}
      </div>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      <ActionError error={error} />
    </form>
  );
}

// ------------------------------------------------------------------ Tags

const DEFAULT_TAG_COLOUR = '#2f5d50';

function TagsSection() {
  const services = useServices();
  const tags = useResource(cacheKeys.tags, tagListSchema, (api) => api.listTags());
  const [name, setName] = useState('');
  const [colour, setColour] = useState(DEFAULT_TAG_COLOUR);
  const { busy, error, run } = useAction();
  return (
    <section className="section" aria-labelledby="settings-tags">
      <h2 id="settings-tags">Tags</h2>
      <div className="card stack-sm">
        <ResourceView resource={tags} loadingLabel="Loading tags…">
          {(list) =>
            list.length === 0 ? (
              <p className="small muted">No tags yet.</p>
            ) : (
              <ul className="list">
                {list.map((tag) => (
                  <li key={tag.id} className="list-item">
                    <TagRow tag={tag} />
                  </li>
                ))}
              </ul>
            )
          }
        </ResourceView>
        <form
          className="stack-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === '') return;
            run(async () => {
              await services.api.createTag({ id: services.newId(), name: name.trim(), colour });
              setName('');
              invalidate(services);
            });
          }}
        >
          <h3>New tag</h3>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <label htmlFor="new-tag-name" className="sr-only">
              Tag name
            </label>
            <input
              id="new-tag-name"
              placeholder="Tag name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <label htmlFor="new-tag-colour" className="sr-only">
              Tag colour
            </label>
            <input
              id="new-tag-colour"
              type="color"
              value={colour}
              onChange={(event) => {
                setColour(event.target.value);
              }}
            />
            <button type="submit" className="btn btn-small" disabled={busy || name.trim() === ''}>
              Add
            </button>
          </div>
        </form>
        <ActionError error={error} />
      </div>
    </section>
  );
}

function TagRow({ tag }: { tag: Tag }) {
  const services = useServices();
  const [name, setName] = useState(tag.name);
  const [colour, setColour] = useState(tag.colour ?? DEFAULT_TAG_COLOUR);
  const { busy, error, run } = useAction();
  const changed = name.trim() !== tag.name || colour !== (tag.colour ?? DEFAULT_TAG_COLOUR);
  return (
    <form
      className="grow stack-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || name.trim() === '') return;
        run(async () => {
          await services.api.updateTag(tag.id, { name: name.trim(), colour });
          invalidate(services);
        });
      }}
    >
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <label htmlFor={`tag-${tag.id}`} className="sr-only">
          Name of tag {tag.name}
        </label>
        <input
          id={`tag-${tag.id}`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <label htmlFor={`tag-colour-${tag.id}`} className="sr-only">
          Colour of tag {tag.name}
        </label>
        <input
          id={`tag-colour-${tag.id}`}
          type="color"
          value={colour}
          onChange={(event) => {
            setColour(event.target.value);
          }}
        />
      </div>
      <div className="row">
        <button type="submit" className="btn btn-small" disabled={busy || !changed}>
          Save
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Delete the tag “${tag.name}”? Books keep everything else.`))
              return;
            run(async () => {
              await services.api.deleteTag(tag.id);
              invalidate(services);
            });
          }}
        >
          Delete
        </button>
      </div>
      <ActionError error={error} />
    </form>
  );
}

// ------------------------------------------------------------------ Backup

function backupSummary(envelope: BackupEnvelope): string {
  const live = (rows: { deletedAt: string | null }[]) =>
    rows.filter((row) => row.deletedAt === null).length;
  const { data } = envelope;
  return `${plural(live(data.books), 'book')}, ${plural(live(data.sessions), 'session')} and ${plural(live(data.notes), 'note')}`;
}

function BackupSection() {
  const services = useServices();
  const exporting = useAction();
  const importing = useAction();
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<BackupImportResponse | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const exportBackup = () => {
    setExportMessage(null);
    exporting.run(async () => {
      const envelope = await services.api.exportBackup();
      const filename = `bookshelf-backup-${localDateKey(envelope.exportedAt, services.timeZone)}.json`;
      const outcome = await saveTextFile(filename, `${JSON.stringify(envelope, null, 2)}\n`);
      if (outcome !== 'cancelled') {
        setExportMessage(`Exported ${backupSummary(envelope)} as ${filename}.`);
      }
    });
  };

  const importFile = async (file: File) => {
    setFileError(null);
    setImportResult(null);
    let json: unknown;
    try {
      json = JSON.parse(await readFileText(file));
    } catch {
      setFileError('That file isn’t valid JSON.');
      return;
    }
    const parsed = backupEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      setFileError('That file isn’t a Bookshelf backup.');
      return;
    }
    const envelope = parsed.data;
    const confirmed = window.confirm(
      `Replace ALL your data with this backup from ${formatDate(envelope.exportedAt, services.timeZone)} (${backupSummary(envelope)})? A safety snapshot of your current data is saved on the server first.`,
    );
    if (!confirmed) return;
    importing.run(async () => {
      const result = await services.api.importBackup(envelope);
      setImportResult(result);
      invalidate(services);
    });
  };

  return (
    <section className="section" aria-labelledby="settings-backup">
      <h2 id="settings-backup">Backup</h2>
      <div className="card stack-sm">
        <p className="small muted">
          The server also keeps daily snapshots. Export a copy to keep somewhere else, or restore
          one.
        </p>
        <button type="button" className="btn" disabled={exporting.busy} onClick={exportBackup}>
          {exporting.busy ? 'Exporting…' : 'Export backup (JSON)'}
        </button>
        {exportMessage && (
          <p className="small" role="status">
            {exportMessage}
          </p>
        )}
        <ActionError error={exporting.error} />

        <div className="field">
          <label htmlFor="import-file">Restore from a backup file</label>
          <input
            id="import-file"
            type="file"
            accept="application/json,.json"
            disabled={importing.busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <span className="field-hint">This replaces everything on the server.</span>
        </div>
        {importing.busy && <p role="status">Restoring…</p>}
        {fileError && (
          <p className="error-text" role="alert">
            {fileError}
          </p>
        )}
        {importResult && (
          <p role="status">
            Restored {plural(importResult.imported.books, 'book')},{' '}
            {plural(importResult.imported.sessions, 'session')} and{' '}
            {plural(importResult.imported.notes, 'note')}. Safety snapshot: {importResult.snapshot}.
          </p>
        )}
        <ActionError error={importing.error} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Bookpine

function countsLine(
  label: string,
  counts: { created: number; updated: number; unchanged: number; skipped: number },
  dryRun: boolean,
): string {
  const parts = [
    `${counts.created} ${dryRun ? 'to add' : 'added'}`,
    `${counts.updated} ${dryRun ? 'to update' : 'updated'}`,
    `${counts.unchanged} unchanged`,
  ];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped (deleted in Bookshelf)`);
  return `${label}: ${parts.join(', ')}`;
}

/** The preview or import report (SPEC §8.1) in words. */
function BookpineReportView({ report }: { report: BookpineReport }) {
  const { dryRun } = report;
  const lookups = dryRun ? report.enrichment.pending : null;
  return (
    <div className="stack-sm" aria-label={dryRun ? 'Import preview' : 'Import result'} role="group">
      <p className="small">
        {plural(report.rows, 'row')} in the export
        {report.merges.length > 0 &&
          `, with ${plural(report.merges.length, 'book')} in several editions merged`}
        .
      </p>
      <ul className="small">
        <li>
          {countsLine('Books', report.books, dryRun)}
          {report.books.matched > 0 &&
            ` · ${report.books.matched} linked to books already in your library`}
        </li>
        <li>{countsLine('Reads', report.reads, dryRun)}</li>
        <li>
          {countsLine('Reading days (sessions)', report.sessions, dryRun)} ·{' '}
          {report.sessions.untimed} with time unknown
        </li>
        <li>{countsLine('Formats', report.formats, dryRun)}</li>
        <li>{countsLine('Notes', report.notes, dryRun)}</li>
        <li>
          {report.tags.created === 0 ? 'No new tags' : `New tags: ${report.tags.names.join(', ')}`}
        </li>
        {report.keptEdits > 0 && (
          <li>{plural(report.keptEdits, 'field')} you changed in Bookshelf kept as they are</li>
        )}
        {lookups !== null ? (
          lookups > 0 && (
            <li>
              Covers and details will be looked up for {plural(lookups, 'book')} (about{' '}
              {Math.max(1, Math.ceil((lookups * 2) / 60))} min)
            </li>
          )
        ) : (
          <li>
            Looked up: {report.enrichment.found} found, {report.enrichment.notFound} not found,{' '}
            {report.enrichment.failed} failed · {plural(report.covers.cached, 'cover')} saved
          </li>
        )}
      </ul>
      {report.merges.length > 0 && (
        <details>
          <summary className="small">Merged editions ({report.merges.length})</summary>
          <ul className="small">
            {report.merges.map((merge) => (
              <li key={merge.slugs.join(',')}>
                {merge.title} ({plural(merge.slugs.length, 'edition')})
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.warnings.length > 0 && (
        <details>
          <summary className="small">Warnings ({report.warnings.length})</summary>
          <ul className="small">
            {report.warnings.map((warning, index) => (
              <li key={`${String(index)}-${warning.message}`}>
                {warning.slug ? (
                  <>
                    <code>{warning.slug}</code>: {warning.message}
                  </>
                ) : (
                  warning.message
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.snapshot && <p className="small muted">Safety snapshot: {report.snapshot}</p>}
    </div>
  );
}

function BookpineSection() {
  const services = useServices();
  const previewing = useAction();
  const importing = useAction();
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<BookpineReport | null>(null);
  const [result, setResult] = useState<BookpineReport | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const pick = async (file: File) => {
    setFileError(null);
    setPreview(null);
    setResult(null);
    importing.clearError();
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setFileError('That file couldn’t be read.');
      return;
    }
    setCsv(text);
    previewing.run(async () => {
      setPreview(await services.api.previewBookpine(text));
    });
  };

  const cancel = () => {
    setCsv(null);
    setPreview(null);
  };

  return (
    <section className="section" aria-labelledby="settings-bookpine">
      <h2 id="settings-bookpine">Import from Bookpine</h2>
      <div className="card stack-sm">
        <p className="small muted">
          Import your Bookpine CSV export. You’ll see what would change before anything is saved;
          importing again later only adds and updates what changed in Bookpine.
        </p>
        <div className="field">
          <label htmlFor="bookpine-file">Bookpine export (CSV)</label>
          <input
            id="bookpine-file"
            type="file"
            accept=".csv,text/csv"
            disabled={previewing.busy || importing.busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void pick(file);
            }}
          />
        </div>
        {fileError && (
          <p className="error-text" role="alert">
            {fileError}
          </p>
        )}
        {previewing.busy && <p role="status">Checking the export…</p>}
        <ActionError error={previewing.error} />
        {preview && csv !== null && !result && (
          <div className="stack-sm">
            <h3>Preview</h3>
            <BookpineReportView report={preview} />
            {importing.busy ? (
              <p role="status">
                Importing — looking up covers and details can take a few minutes. Keep this page
                open.
              </p>
            ) : (
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    importing.run(async () => {
                      const report = await services.api.importBookpine(csv);
                      setResult(report);
                      setPreview(null);
                      setCsv(null);
                      invalidate(services);
                    });
                  }}
                >
                  Import
                </button>
                <button type="button" className="btn btn-ghost" onClick={cancel}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
        <ActionError error={importing.error} />
        {result && (
          <div className="stack-sm" role="status">
            <h3>Imported</h3>
            <BookpineReportView report={result} />
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Notion

function notionSummary(result: NotionRunResult): string {
  const part = (name: string, c: NotionRunResult['books']) =>
    `${name}: ${c.created} new, ${c.updated} updated, ${c.archived} archived, ${c.unchanged} unchanged`;
  return [
    part('Books', result.books),
    part('Sessions', result.sessions),
    part('Notes', result.notes),
  ].join('; ');
}

function NotionSection() {
  const services = useServices();
  const status = useResource(cacheKeys.notionStatus, notionStatusSchema, (api) =>
    api.notionStatus(),
  );
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<NotionRunResult | null>(null);
  const running = busy || status.data?.running === true;
  return (
    <section className="section" aria-labelledby="settings-notion">
      <h2 id="settings-notion">Notion mirror</h2>
      <div className="card stack-sm">
        <ResourceView resource={status} loadingLabel="Checking Notion…">
          {(data) =>
            data.configured ? (
              <div className="stack-sm">
                <p className="small">
                  {data.lastSuccessAt
                    ? `Last synced ${formatDate(data.lastSuccessAt, services.timeZone)}.`
                    : 'Not synced yet.'}
                </p>
                {data.lastError && (
                  <p className="small error-text">Last attempt failed: {data.lastError}</p>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={running}
                  aria-busy={running}
                  onClick={() => {
                    setResult(null);
                    run(async () => {
                      setResult(await services.api.notionRun());
                      invalidate(services);
                    });
                  }}
                >
                  {running ? 'Syncing to Notion…' : 'Sync to Notion now'}
                </button>
                {running && (
                  <p className="small muted" role="status">
                    Syncing — a large library can take a few minutes. You can keep using the app.
                  </p>
                )}
              </div>
            ) : (
              <p className="small muted">
                Notion isn’t set up. Add <code>NOTION_TOKEN</code> and{' '}
                <code>NOTION_PARENT_PAGE_ID</code> to the server’s <code>.env</code> (see the
                README).
              </p>
            )
          }
        </ResourceView>
        {result && (
          <p className="small" role="status">
            Done. {notionSummary(result)}.
          </p>
        )}
        <ActionError error={error} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Server

function ServerSection() {
  const reachable = useReachable();
  const health = useResource(cacheKeys.health, healthResponseSchema, (api) => api.health());
  const online = reachable && !health.fromCache && health.data !== undefined;
  return (
    <section className="section" aria-labelledby="settings-server">
      <h2 id="settings-server">Server</h2>
      <div className="card stack-sm">
        <p role="status">
          {health.loading && health.data === undefined
            ? 'Checking the server…'
            : online
              ? 'Connected.'
              : 'The server can’t be reached.'}
        </p>
        {health.data && (
          <dl className="small" style={{ margin: 0 }}>
            <dt className="muted">Version</dt>
            <dd style={{ margin: 0 }}>{health.data.version}</dd>
            <dt className="muted">Database</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{health.data.dbPath}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ Outbox

function OutboxSection() {
  const services = useServices();
  const counts = useOutboxCounts();
  const [ops, setOps] = useState<OutboxRecord[]>([]);
  const { busy, error, run } = useAction();

  useEffect(() => {
    let active = true;
    const load = () => {
      void services.outbox.list().then((list) => {
        if (active) setOps(list);
      });
    };
    load();
    const unsubscribe = services.outbox.subscribe(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [services]);

  return (
    <section className="section" aria-labelledby="settings-outbox">
      <h2 id="settings-outbox">Offline changes</h2>
      <div className="card stack-sm">
        <p role="status">
          {counts.pending === 0 && counts.failed === 0
            ? 'Everything is synced.'
            : [
                counts.pending > 0 ? `${plural(counts.pending, 'change')} waiting to sync` : null,
                counts.failed > 0 ? `${plural(counts.failed, 'change')} couldn’t sync` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </p>
        {services.outbox.lastReplayAt && (
          <p className="small muted">
            Last sync attempt {formatDate(services.outbox.lastReplayAt, services.timeZone)}.
          </p>
        )}
        {counts.pending > 0 && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              run(() => syncNow(services));
            }}
          >
            {busy ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        {ops.length > 0 && (
          <ul className="list" aria-label="Queued changes">
            {ops.map((op) => (
              <li key={op.seq} className="list-item">
                <div className="grow stack-sm">
                  <p>
                    <strong>{op.label}</strong>{' '}
                    <span className="pill">{op.state === 'failed' ? 'Failed' : 'Waiting'}</span>
                  </p>
                  <p className="small muted">
                    Saved {formatDate(op.createdAt, services.timeZone)}
                    {op.attempts > 0 && ` · ${plural(op.attempts, 'attempt')}`}
                  </p>
                  {op.lastError && <p className="small error-text">{op.lastError.message}</p>}
                  <div className="row">
                    {op.state === 'failed' && (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          const seq = op.seq;
                          if (seq !== undefined) run(() => services.outbox.retry(seq));
                        }}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => {
                        if (op.seq === undefined) return;
                        if (!window.confirm(`Discard “${op.label}”? This change will be lost.`))
                          return;
                        const seq = op.seq;
                        run(async () => {
                          await services.outbox.discard(seq);
                          invalidate(services);
                        });
                      }}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error !== null && (
          <p className="error-text" role="alert">
            {errorMessage(error)}
          </p>
        )}
      </div>
    </section>
  );
}
