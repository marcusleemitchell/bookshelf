/**
 * Import provenance (SPEC §8): maps a source record (e.g. a Bookpine slug)
 * to the local row it became, with the values the import last wrote. Links
 * are per member (ADR 0010): each member imports their own export.
 */
import type { ImportLink, ImportLinkEntity, ImportSource } from '../../shared/index.ts';
import { all, run, type Db } from '../db/database.ts';

/** An import link as stored, with the member it belongs to. */
export type MemberImportLink = ImportLink & { memberId: string };

interface LinkRow {
  member_id: string;
  source: ImportSource;
  entity: ImportLinkEntity;
  external_id: string;
  local_id: string;
  imported: string;
  imported_at: string;
}

function fromRow(row: LinkRow): MemberImportLink {
  return {
    memberId: row.member_id,
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
  memberId: string,
  source: ImportSource,
  entity: ImportLinkEntity,
  externalId: string,
): MemberImportLink | undefined {
  const row = all<LinkRow>(
    db,
    `SELECT * FROM import_links
     WHERE member_id = ? AND source = ? AND entity = ? AND external_id = ?`,
    [memberId, source, entity, externalId],
  )[0];
  return row ? fromRow(row) : undefined;
}

/** The member's links of one entity type pointing at `localId`. */
export function linksToLocal(
  db: Db,
  memberId: string,
  entity: ImportLinkEntity,
  localId: string,
): MemberImportLink[] {
  return all<LinkRow>(
    db,
    `SELECT * FROM import_links WHERE member_id = ? AND entity = ? AND local_id = ?
     ORDER BY external_id`,
    [memberId, entity, localId],
  ).map(fromRow);
}

export function saveImportLink(db: Db, link: MemberImportLink): void {
  run(
    db,
    `INSERT INTO import_links (member_id, source, entity, external_id, local_id, imported, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id, source, entity, external_id) DO UPDATE SET
       local_id = excluded.local_id, imported = excluded.imported,
       imported_at = excluded.imported_at`,
    [
      link.memberId,
      link.source,
      link.entity,
      link.externalId,
      link.localId,
      JSON.stringify(link.imported),
      link.importedAt,
    ],
  );
}

/** Every member's links, for backups. */
export function listImportLinks(db: Db): MemberImportLink[] {
  return all<LinkRow>(
    db,
    'SELECT * FROM import_links ORDER BY member_id, source, entity, external_id',
  ).map(fromRow);
}

export function deleteAllImportLinks(db: Db): void {
  run(db, 'DELETE FROM import_links');
}
