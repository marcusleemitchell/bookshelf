import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupEnvelopeSchema,
  familyBackupEnvelopeSchema,
  type BackupData,
  type BackupImportResponse,
  type BookDetail,
  type FamilyBackupEnvelope,
  type Session,
} from '../../shared/index.ts';
import { all } from '../db/database.ts';
import { loadMigrations } from '../db/migrate.ts';
import { BACKUP_V1, BACKUP_V5 } from '../test/fixtures/backup.ts';
import { pruneSnapshots, SNAPSHOTS_TO_KEEP, writeSnapshot } from '../services/backup.ts';
import { startSnapshotScheduler } from '../services/snapshots.ts';
import { createTestEnv, type TestEnv } from '../test/helpers.ts';

let env: TestEnv;

const EMPTY: BackupData = {
  members: [],
  books: [],
  shelfEntries: [],
  formats: [],
  reads: [],
  sessions: [],
  tags: [],
  notes: [],
  goals: [],
  timers: [],
  importLinks: [],
};

beforeEach(() => {
  env = createTestEnv();
});

afterEach(() => {
  env.cleanup();
});

async function seedLibrary(): Promise<BookDetail> {
  const tag = (
    await env.request<{ id: string }>('POST', '/api/tags', { name: 'Essays', colour: '#112233' })
  ).body;
  const book = (
    await env.request<BookDetail>('POST', '/api/books', {
      title: 'Braiding Sweetgrass',
      authors: ['Robin Wall Kimmerer'],
      genres: ['Nature'],
      isbn13: '9781571313560',
      tagIds: [tag.id],
      rating: 4.5,
      formats: [
        { format: 'physical', pageCount: 408 },
        { format: 'audiobook', audioDurationSeconds: 60_000 },
      ],
    })
  ).body;
  const physical = book.formats.find((f) => f.format === 'physical')?.id as string;
  await env.request('POST', '/api/sessions', {
    bookId: book.id,
    formatId: physical,
    startedAt: '2026-11-13T19:00:00Z',
    endedAt: '2026-11-13T20:00:00Z',
    progressUnit: 'pages',
    startValue: 0,
    endValue: 51,
    note: 'Skywoman Falling',
  });
  const removed = await env.request<{ id: string }>('POST', '/api/sessions', {
    bookId: book.id,
    formatId: physical,
    startedAt: '2026-11-12T19:00:00Z',
    endedAt: '2026-11-12T19:10:00Z',
    progressUnit: 'pages',
    endValue: 5,
  });
  await env.request('DELETE', `/api/sessions/${removed.body.id}`);
  await env.request('POST', `/api/books/${book.id}/notes`, {
    kind: 'quote',
    text: 'All flourishing is mutual.',
    location: 'p. 166',
  });
  await env.request('PUT', '/api/goals/55555555-5555-4555-8555-555555555555', {
    kind: 'books_per_year',
    year: 2026,
    target: 24,
  });
  await env.request('PUT', '/api/timer', { action: 'start', bookId: book.id, formatId: physical });
  return book;
}

describe('GET /api/backup/export', () => {
  it('exports every table, including soft-deleted rows, in a versioned envelope', async () => {
    const book = await seedLibrary();
    const res = await env.app.request('/api/backup/export', { headers: env.authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="bookshelf-backup-2026-11-14.json"',
    );
    const body = (await res.json()) as FamilyBackupEnvelope;
    const envelope = familyBackupEnvelopeSchema.parse(body);
    expect(envelope).toMatchObject({
      app: 'bookshelf',
      schemaVersion: loadMigrations().length,
      exportedAt: '2026-11-14T12:00:00.000Z',
    });
    // Members: profile and admin flag only, never PIN state.
    expect(body.data.members).toEqual([
      {
        id: env.owner.id,
        name: 'Owner',
        role: 'parent',
        isAdmin: true,
        createdAt: env.owner.createdAt,
        updatedAt: env.owner.updatedAt,
        deletedAt: null,
      },
    ]);
    expect(envelope.data.books.map((b) => b.id)).toEqual([book.id]);
    expect(envelope.data.books[0]).not.toHaveProperty('status');
    expect(envelope.data.shelfEntries).toEqual([
      expect.objectContaining({
        memberId: env.owner.id,
        bookId: book.id,
        status: 'reading',
        rating: 4.5,
        tagIds: book.tagIds,
      }),
    ]);
    expect(book.tagIds).toHaveLength(1);
    expect(envelope.data.formats).toHaveLength(2);
    expect(envelope.data.reads).toHaveLength(1);
    expect(envelope.data.sessions).toHaveLength(2);
    expect(envelope.data.sessions.filter((s) => s.deletedAt !== null)).toHaveLength(1);
    expect(envelope.data.tags).toHaveLength(1);
    expect(envelope.data.notes).toHaveLength(1);
    expect(envelope.data.goals).toHaveLength(1);
    expect(envelope.data.timers.map((t) => t.bookId)).toEqual([book.id]);
    for (const rows of [
      envelope.data.reads,
      envelope.data.sessions,
      envelope.data.tags,
      envelope.data.notes,
      envelope.data.goals,
      envelope.data.timers,
    ]) {
      expect(rows.every((row) => row.memberId === env.owner.id)).toBe(true);
    }
    expect(envelope.data.notes[0]?.shared).toBe(false);
  });

  it('is for parents and admins only', async () => {
    const child = env.addMember({ name: 'Kit', role: 'child' });
    const res = await child.request<{ error: { code: string } }>('GET', '/api/backup/export');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    const parent = env.addMember({ name: 'Jo' });
    expect((await parent.request('GET', '/api/backup/export')).status).toBe(200);
  });
});

describe('POST /api/backup/import', () => {
  it('round-trips: export → wipe → import → identical export', async () => {
    await seedLibrary();
    const exported = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;

    const wiped = await env.request<BackupImportResponse>('POST', '/api/backup/import', {
      ...exported,
      data: { ...EMPTY, members: exported.data.members },
    });
    expect(wiped.status).toBe(200);
    expect((await env.request('GET', '/api/books')).body).toEqual([]);

    env.clock.advance(1000);
    const imported = await env.request<BackupImportResponse>(
      'POST',
      '/api/backup/import',
      exported,
    );
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toEqual({
      books: 1,
      formats: 2,
      reads: 1,
      sessions: 2,
      tags: 1,
      notes: 1,
      goals: 1,
      timer: 1,
    });
    expect(imported.body.snapshot).toBe('bookshelf-pre-import-2026-11-14T12-00-01-000Z.json');

    const again = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    expect(again.data).toEqual(exported.data);
  });

  it('writes a pre-import snapshot of the data being replaced', async () => {
    await seedLibrary();
    const before = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    const res = await env.request<BackupImportResponse>('POST', '/api/backup/import', {
      ...before,
      data: { ...EMPTY, members: before.data.members, tags: before.data.tags },
    });
    const snapshot = JSON.parse(
      readFileSync(join(env.ctx.config.backupsDir, res.body.snapshot), 'utf8'),
    ) as FamilyBackupEnvelope;
    expect(snapshot.data).toEqual(before.data);
  });

  it('is all-or-nothing when the backup is inconsistent', async () => {
    const book = await seedLibrary();
    const exported = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    const broken = {
      ...exported,
      data: { ...exported.data, books: [] },
    };
    const res = await env.request<{ error: { code: string; message: string } }>(
      'POST',
      '/api/backup/import',
      broken,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.message).toContain('existing data is unchanged');
    expect((await env.request<BookDetail>('GET', `/api/books/${book.id}`)).status).toBe(200);
    // The safety snapshot was still written.
    expect(
      readdirSync(env.ctx.config.backupsDir).some((f) => f.startsWith('bookshelf-pre-import-')),
    ).toBe(true);
  });

  it('restores a schema version 1 backup: its sessions were logged in the app', async () => {
    const res = await env.request<BackupImportResponse>('POST', '/api/backup/import', BACKUP_V1);
    expect(res.status).toBe(200);
    expect(res.body.imported).toMatchObject({ books: 1, formats: 1, reads: 1, sessions: 1 });
    const sessions = await env.request<Session[]>('GET', '/api/sessions');
    expect(sessions.body).toEqual([
      expect.objectContaining({ durationSeconds: 1800, source: 'app', endPercent: 9.85 }),
    ]);
    const exported = familyBackupEnvelopeSchema.parse(
      (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body,
    );
    expect(exported.schemaVersion).toBe(loadMigrations().length);
    expect(exported.data.sessions[0]?.source).toBe('app');
    expect(exported.data.sessions[0]?.memberId).toBe(env.owner.id);
  });

  it('restores a schema version 5 backup into the owner, books becoming their shelf', async () => {
    const parent = env.addMember({ name: 'Jo' });
    const res = await env.request<BackupImportResponse>('POST', '/api/backup/import', BACKUP_V5);
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual({
      books: 2,
      formats: 1,
      reads: 1,
      sessions: 1,
      tags: 1,
      notes: 1,
      goals: 1,
      timer: 1,
    });
    const [kindred, sower] = BACKUP_V5.data.books;
    const shelf = await env.request<BookDetail[]>('GET', '/api/books');
    expect(shelf.body).toEqual([
      expect.objectContaining({
        id: kindred.id,
        status: 'paused',
        rating: 4,
        tagIds: kindred.tagIds,
      }),
    ]);
    expect((await env.request<{ timer: { id: string } }>('GET', '/api/timer')).body.timer.id).toBe(
      BACKUP_V5.data.timer.id,
    );
    // Nothing went to the other member.
    expect((await parent.request('GET', '/api/books')).body).toEqual([]);
    expect((await parent.request('GET', '/api/tags')).body).toEqual([]);

    const exported = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    expect(exported.data.shelfEntries).toEqual([
      {
        memberId: env.owner.id,
        bookId: kindred.id,
        status: 'paused',
        rating: 4,
        tagIds: kindred.tagIds,
        createdAt: kindred.createdAt,
        updatedAt: kindred.updatedAt,
        deletedAt: null,
      },
      {
        memberId: env.owner.id,
        bookId: sower.id,
        status: 'finished',
        rating: null,
        tagIds: [],
        createdAt: sower.createdAt,
        updatedAt: sower.updatedAt,
        deletedAt: sower.deletedAt,
      },
    ]);
    expect(exported.data.books.map((b) => b.deletedAt)).toEqual([null, sower.deletedAt]);
    expect(exported.data.sessions[0]).toMatchObject({
      memberId: env.owner.id,
      durationSeconds: null,
      source: 'bookpine',
    });
    expect(exported.data.importLinks).toEqual([
      { ...BACKUP_V5.data.importLinks[0], memberId: env.owner.id },
    ]);
    expect(exported.data.timers.map((t) => t.memberId)).toEqual([env.owner.id]);
    expect(exported.data.members.map((m) => m.name)).toEqual(['Owner', 'Jo']);
  });

  it('restores every member’s data, upserting members and keeping PINs', async () => {
    await seedLibrary();
    const jo = env.addMember({ name: 'Jo' });
    const tag = (await jo.request<{ id: string }>('POST', '/api/tags', { name: 'Mine' })).body;
    await jo.request('POST', '/api/books', {
      title: 'Braiding Sweetgrass',
      isbn13: '9781571313560',
      status: 'finished',
      rating: 5,
      tagIds: [tag.id],
    });
    env.ctx.db.exec('UPDATE book_notes SET shared = 1');
    env.ctx.db.exec(`UPDATE members SET pin_hash = 'kept' WHERE id = '${jo.member.id}'`);
    const exported = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    expect(exported.data.books).toHaveLength(1);
    expect(exported.data.shelfEntries.map((e) => [e.memberId, e.status, e.tagIds])).toEqual([
      [env.owner.id, 'reading', expect.any(Array)],
      [jo.member.id, 'finished', [tag.id]],
    ]);
    expect(exported.data.notes[0]?.shared).toBe(true);

    // A member only in the backup is added without a PIN; one only in the database is kept.
    const kit = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Kit',
      role: 'child',
      isAdmin: false,
      createdAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T10:00:00.000Z',
      deletedAt: null,
    } as const;
    const ash = env.addMember({ name: 'Ash' });
    const res = await env.request('POST', '/api/backup/import', {
      ...exported,
      data: {
        ...exported.data,
        members: [
          ...exported.data.members.filter((m) => m.id !== ash.member.id),
          { ...kit },
          { ...exported.data.members[1], name: 'Joanna' },
        ].filter((m, i, list) => list.findIndex((other) => other.id === m.id) === i),
      },
    });
    expect(res.status).toBe(200);
    const members = all<{ id: string; name: string; pin_hash: string | null }>(
      env.ctx.db,
      'SELECT id, name, pin_hash FROM members ORDER BY created_at',
    );
    expect(members).toEqual(
      expect.arrayContaining([
        { id: kit.id, name: 'Kit', pin_hash: null },
        { id: jo.member.id, name: 'Jo', pin_hash: 'kept' },
        { id: ash.member.id, name: 'Ash', pin_hash: null },
      ]),
    );
    const again = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    expect(again.data.shelfEntries).toEqual(exported.data.shelfEntries);
    expect(again.data.notes).toEqual(exported.data.notes);
    expect((await jo.request<BookDetail[]>('GET', '/api/books')).body).toEqual([
      expect.objectContaining({ status: 'finished', rating: 5, tagIds: [tag.id] }),
    ]);
  });

  it('refuses a backup that leaves no admin or links another member’s tag', async () => {
    await seedLibrary();
    const jo = env.addMember({ name: 'Jo' });
    const exported = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    const noAdmin = await env.request<{ error: { message: string } }>(
      'POST',
      '/api/backup/import',
      {
        ...exported,
        data: {
          ...exported.data,
          members: exported.data.members.map((m) => ({ ...m, isAdmin: false })),
        },
      },
    );
    expect(noAdmin.status).toBe(400);
    expect(noAdmin.body.error.message).toContain('leaves no admin');

    const data: BackupData = structuredClone(exported.data);
    const [entry] = data.shelfEntries;
    if (!entry) throw new Error('fixture');
    data.shelfEntries.push({ ...entry, memberId: jo.member.id });
    const foreign = await env.request<{ error: { message: string } }>(
      'POST',
      '/api/backup/import',
      { ...exported, data },
    );
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.message).toContain('is not the shelf owner’s');
    // Nothing changed.
    expect((await jo.request('GET', '/api/books')).body).toEqual([]);
    expect((await env.request<BookDetail[]>('GET', '/api/books')).body).toHaveLength(1);
  });

  it('round-trips untimed imported sessions and paused books from an older backup', async () => {
    const imported = structuredClone(BACKUP_V1) as unknown as {
      data: {
        books: { status: string }[];
        sessions: { durationSeconds: number | null; source?: string }[];
      };
    };
    const [book] = imported.data.books;
    const [session] = imported.data.sessions;
    if (!book || !session) throw new Error('fixture');
    book.status = 'paused';
    session.durationSeconds = null;
    session.source = 'bookpine';
    const res = await env.request('POST', '/api/backup/import', { ...imported, schemaVersion: 6 });
    expect(res.status).toBe(200);
    const exported = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    expect(exported.data.shelfEntries[0]?.status).toBe('paused');
    expect(exported.data.sessions[0]).toMatchObject({ durationSeconds: null, source: 'bookpine' });
  });

  it('rejects other apps, newer schema versions and malformed files', async () => {
    const exported = (await env.request<FamilyBackupEnvelope>('GET', '/api/backup/export')).body;
    const other = await env.request<{ error: { code: string } }>('POST', '/api/backup/import', {
      ...exported,
      app: 'bookpine',
    });
    expect(other.body.error.code).toBe('validation_error');
    const newer = await env.request<{ error: { code: string } }>('POST', '/api/backup/import', {
      ...exported,
      schemaVersion: 99,
    });
    expect(newer.status).toBe(400);
    expect(newer.body.error.code).toBe('unsupported_backup');
    expect((await env.request('POST', '/api/backup/import', '{"app":')).status).toBe(400);
    // The family format needs the family schema version, and an older one its own format.
    const mixed = await env.request('POST', '/api/backup/import', {
      ...BACKUP_V1,
      schemaVersion: loadMigrations().length,
    });
    expect(mixed.status).toBe(400);
    expect(backupEnvelopeSchema.safeParse({ ...exported, schemaVersion: 5 }).success).toBe(false);
  });

  it('refuses a child before reading the upload', async () => {
    const child = env.addMember({ name: 'Kit', role: 'child' });
    const res = await child.request<{ error: { code: string } }>(
      'POST',
      '/api/backup/import',
      BACKUP_V5,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(readdirSync(env.ctx.config.backupsDir)).toEqual([]);
  });
});

describe('snapshots', () => {
  it('writes a daily snapshot named by local date and keeps the newest 14', () => {
    for (let day = 1; day <= 20; day += 1) {
      writeFileSync(
        join(env.ctx.config.backupsDir, `bookshelf-2026-10-${String(day).padStart(2, '0')}.json`),
        '{}',
      );
    }
    writeFileSync(
      join(env.ctx.config.backupsDir, 'bookshelf-pre-import-2026-10-01T00-00-00-000Z.json'),
      '{}',
    );
    writeFileSync(join(env.ctx.config.backupsDir, 'notes.txt'), 'keep me');
    expect(writeSnapshot(env.ctx, 'daily')).toBe('bookshelf-2026-11-14.json');
    const files = readdirSync(env.ctx.config.backupsDir).sort();
    const daily = files.filter((f) => /^bookshelf-\d{4}-\d{2}-\d{2}\.json$/.test(f));
    expect(daily).toHaveLength(SNAPSHOTS_TO_KEEP);
    expect(daily[0]).toBe('bookshelf-2026-10-08.json');
    expect(daily.at(-1)).toBe('bookshelf-2026-11-14.json');
    expect(files).toContain('bookshelf-pre-import-2026-10-01T00-00-00-000Z.json');
    expect(files).toContain('notes.txt');
    expect(pruneSnapshots(env.ctx)).toEqual([]);
    const content = backupEnvelopeSchema.parse(
      JSON.parse(
        readFileSync(join(env.ctx.config.backupsDir, 'bookshelf-2026-11-14.json'), 'utf8'),
      ),
    );
    expect(content.app).toBe('bookshelf');
  });

  it('snapshots at startup and then daily at 03:00 local time', () => {
    env.clock.set('2026-11-14T01:30:00.000Z');
    const scheduler = startSnapshotScheduler(env.ctx, { intervalMs: 3_600_000 });
    const written = () =>
      env.logs.filter((l) => l['msg'] === 'Snapshot written').map((l) => l['reason']);
    expect(written()).toEqual(['startup']);

    env.clock.set('2026-11-14T02:59:00.000Z');
    scheduler.tick();
    expect(written()).toEqual(['startup']);

    env.clock.set('2026-11-14T03:00:00.000Z');
    scheduler.tick();
    scheduler.tick();
    expect(written()).toEqual(['startup', 'daily']);

    env.clock.set('2026-11-15T09:00:00.000Z');
    scheduler.tick();
    expect(written()).toEqual(['startup', 'daily', 'daily']);
    scheduler.stop();
  });

  it('counts a startup after 03:00 as that day’s snapshot', () => {
    env.clock.set('2026-11-14T08:00:00.000Z');
    const scheduler = startSnapshotScheduler(env.ctx);
    scheduler.tick();
    const reasons = env.logs.filter((l) => l['msg'] === 'Snapshot written').map((l) => l['reason']);
    expect(reasons).toEqual(['startup']);
    scheduler.stop();
  });

  it('logs and survives snapshot failures', () => {
    env.ctx.db.close();
    const scheduler = startSnapshotScheduler(env.ctx);
    expect(env.logs.some((l) => l['msg'] === 'Snapshot failed')).toBe(true);
    scheduler.stop();
  });
});
