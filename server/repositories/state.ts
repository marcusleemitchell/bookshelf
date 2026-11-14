/**
 * Server-internal state: key/value settings, processed sync ops and the
 * Notion page mapping.
 */
import type { z } from 'zod';
import { all, run, type Db } from '../db/database.ts';

/** A setting parsed with `schema`; null when absent or no longer matching the schema. */
export function getSetting<S extends z.ZodType>(
  db: Db,
  key: string,
  schema: S,
): z.output<S> | null {
  const row = all<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key])[0];
  if (!row) return null;
  const result = schema.safeParse(JSON.parse(row.value));
  return result.success ? result.data : null;
}

export function setSetting(db: Db, key: string, value: unknown, at: string): void {
  run(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), at],
  );
}

export interface SyncOpRecord {
  opId: string;
  entity: string;
  action: 'upsert' | 'delete';
  status: 'applied' | 'stale';
  clientUpdatedAt: string;
  processedAt: string;
}

export function findSyncOp(db: Db, opId: string): SyncOpRecord | undefined {
  const row = all<{
    op_id: string;
    entity: string;
    action: 'upsert' | 'delete';
    status: 'applied' | 'stale';
    client_updated_at: string;
    processed_at: string;
  }>(db, 'SELECT * FROM sync_ops WHERE op_id = ?', [opId])[0];
  if (!row) return undefined;
  return {
    opId: row.op_id,
    entity: row.entity,
    action: row.action,
    status: row.status,
    clientUpdatedAt: row.client_updated_at,
    processedAt: row.processed_at,
  };
}

export function recordSyncOp(db: Db, op: SyncOpRecord): void {
  run(
    db,
    `INSERT INTO sync_ops (op_id, entity, action, status, client_updated_at, processed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [op.opId, op.entity, op.action, op.status, op.clientUpdatedAt, op.processedAt],
  );
}

export type NotionEntity = 'book' | 'session' | 'note';

export interface NotionPageRecord {
  pageId: string;
  contentHash: string;
}

export function findNotionPage(
  db: Db,
  entity: NotionEntity,
  localId: string,
): NotionPageRecord | undefined {
  const row = all<{ page_id: string; content_hash: string }>(
    db,
    'SELECT page_id, content_hash FROM notion_pages WHERE entity = ? AND local_id = ?',
    [entity, localId],
  )[0];
  return row ? { pageId: row.page_id, contentHash: row.content_hash } : undefined;
}

export function saveNotionPage(
  db: Db,
  entity: NotionEntity,
  localId: string,
  page: NotionPageRecord,
  at: string,
): void {
  run(
    db,
    `INSERT INTO notion_pages (entity, local_id, page_id, content_hash, synced_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (entity, local_id) DO UPDATE SET page_id = excluded.page_id,
       content_hash = excluded.content_hash, synced_at = excluded.synced_at`,
    [entity, localId, page.pageId, page.contentHash, at],
  );
}

export function deleteNotionPage(db: Db, entity: NotionEntity, localId: string): void {
  run(db, 'DELETE FROM notion_pages WHERE entity = ? AND local_id = ?', [entity, localId]);
}

export function clearNotionPages(db: Db, entity: NotionEntity): void {
  run(db, 'DELETE FROM notion_pages WHERE entity = ?', [entity]);
}
