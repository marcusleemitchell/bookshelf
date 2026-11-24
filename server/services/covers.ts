/**
 * Cover image cache (SPEC §2/§5). Covers are downloaded into
 * `<dataDir>/covers/<bookId>.<ext>` when a book is created (or its cover URL
 * changes) and lazily on first request if missing, e.g. after a restore.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogueBook } from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import { setCoverPath } from '../repositories/books.ts';
import { fetchOk, OutboundError } from './outbound.ts';

const MAX_COVER_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type]),
);

function removeCachedFiles(ctx: AppContext, bookId: string): void {
  if (!existsSync(ctx.config.coversDir)) return;
  for (const file of readdirSync(ctx.config.coversDir)) {
    if (file.startsWith(`${bookId}.`)) rmSync(join(ctx.config.coversDir, file), { force: true });
  }
}

/**
 * Downloads `url` into the cache for `bookId` and records the file name on
 * the book. Returns the file name, or null when the download fails (logged;
 * a missing cover never fails the calling request).
 */
export async function cacheCover(
  ctx: AppContext,
  bookId: string,
  url: string,
): Promise<string | null> {
  try {
    const response = await fetchOk(ctx, url, { headers: { Accept: 'image/*' } }, 15_000);
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const ext = EXTENSIONS[contentType];
    if (!ext) throw new OutboundError(`Unsupported cover content type "${contentType}"`, null);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) {
      throw new OutboundError(
        `Cover size ${bytes.length} bytes is outside the allowed range`,
        null,
      );
    }
    removeCachedFiles(ctx, bookId);
    const fileName = `${bookId}.${ext}`;
    const target = join(ctx.config.coversDir, fileName);
    const temp = `${target}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, target);
    setCoverPath(ctx.db, bookId, fileName);
    return fileName;
  } catch (error) {
    if (!(error instanceof OutboundError)) throw error;
    ctx.logger.warn('Cover download failed', { bookId, error: error.message });
    return null;
  }
}

/** Deletes a book's cached cover and clears its `cover_path`. */
export function clearCover(ctx: AppContext, bookId: string): void {
  removeCachedFiles(ctx, bookId);
  setCoverPath(ctx.db, bookId, null);
}

/** Relative URL clients use to display a book's cover, or null when it has none. */
export function coverSrc(
  book: Pick<CatalogueBook, 'id' | 'coverPath' | 'coverUrl'>,
): string | null {
  return book.coverPath || book.coverUrl ? `/api/covers/${book.id}` : null;
}

export type CoverResult =
  | { kind: 'file'; bytes: Buffer; contentType: string }
  | { kind: 'redirect'; url: string }
  | { kind: 'none' };

function readCached(ctx: AppContext, fileName: string | null): CoverResult | null {
  if (!fileName) return null;
  const path = join(ctx.config.coversDir, fileName);
  if (!existsSync(path)) return null;
  const ext = fileName.split('.').pop() ?? '';
  return {
    kind: 'file',
    bytes: readFileSync(path),
    contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
  };
}

/** Resolves what `GET /api/covers/:bookId` should return. */
export async function resolveCover(
  ctx: AppContext,
  book: Pick<CatalogueBook, 'id' | 'coverPath' | 'coverUrl'>,
): Promise<CoverResult> {
  const cached = readCached(ctx, book.coverPath);
  if (cached) return cached;
  if (!book.coverUrl) return { kind: 'none' };
  const fileName = await cacheCover(ctx, book.id, book.coverUrl);
  return readCached(ctx, fileName) ?? { kind: 'redirect', url: book.coverUrl };
}
