/**
 * Import provenance (SPEC §8): maps a source record (e.g. a Bookpine slug)
 * to the local row it became, with the values the import last wrote.
 */
import type { ImportLink, ImportLinkEntity, ImportSource } from '../../shared/index.ts';
import { all, run, type Db } from '../db/database.ts';

interface LinkRow {
  source: ImportSource;
  entity: ImportLinkEntity;
  external_id: string;
  local_id: string;
  imported: string;
  imported_at: string;
}

function fromRow(row: LinkRow): ImportLink {
  return {
    source: row.source,
    entity: row.entity,
    externalId: row.external_id,
    localId: row.local_id,
    imported: JSON.parse(row.imported) as Record<string, unknown>,
    importedAt: row.imported_at,
  };
}

export function findImportLink(
  db: Db,
  source: ImportSource,
  entity: ImportLinkEntity,
  externalId: string,
): ImportLink | undefined {
  const row = all<LinkRow>(
    db,
    'SELECT * FROM import_links WHERE source = ? AND entity = ? AND external_id = ?',
    [source, entity, externalId],
  )[0];
  return row ? fromRow(row) : undefined;
}

/** Links of one entity type pointing at `localId`. */
export function linksToLocal(db: Db, entity: ImportLinkEntity, localId: string): ImportLink[] {
  return all<LinkRow>(
    db,
    'SELECT * FROM import_links WHERE entity = ? AND local_id = ? ORDER BY external_id',
    [entity, localId],
  ).map(fromRow);
}

export function saveImportLink(db: Db, link: ImportLink): void {
  run(
    db,
    `INSERT INTO import_links (source, entity, external_id, local_id, imported, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, entity, external_id) DO UPDATE SET local_id = excluded.local_id,
       imported = excluded.imported, imported_at = excluded.imported_at`,
    [
      link.source,
      link.entity,
      link.externalId,
      link.localId,
      JSON.stringify(link.imported),
      link.importedAt,
    ],
  );
}

/** Every link, for backups. */
export function listImportLinks(db: Db): ImportLink[] {
  return all<LinkRow>(db, 'SELECT * FROM import_links ORDER BY source, entity, external_id').map(
    fromRow,
  );
}

export function deleteAllImportLinks(db: Db): void {
  run(db, 'DELETE FROM import_links');
}
