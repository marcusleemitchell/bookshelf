/**
 * Data routes: offline sync (the signed-in member's data), and the
 * household-wide JSON backup export/import and Notion mirror, which only
 * parents and admins may use (ADR 0010).
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  backupEnvelopeSchema,
  backupImportResponseSchema,
  localDateKey,
  notionRunResultSchema,
  notionStatusSchema,
  syncRequestSchema,
  syncResponseSchema,
} from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import type { AuthEnv } from '../http/auth.ts';
import { AppError } from '../http/errors.ts';
import { readJson, respond } from '../http/validate.ts';
import { exportBackup, importBackup } from '../services/backup.ts';
import type { NotionMirror } from '../services/notion.ts';
import { parentsOnly, requestScope } from '../services/scope.ts';
import { processSync } from '../services/sync.ts';

/** Largest accepted backup upload. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

export function dataRoutes(ctx: AppContext, notion: NotionMirror): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/sync', async (c) => {
    const { ops } = await readJson(c, syncRequestSchema);
    return respond(c, syncResponseSchema, await processSync(ctx, requestScope(c), ops));
  });

  // Checked before the body is read, so a child's upload is refused straight away.
  app.use('/backup/*', parentsOnly('use backups and Notion'));

  app.get('/backup/export', (c) => {
    const envelope = exportBackup(ctx);
    const day = localDateKey(envelope.exportedAt, ctx.config.timeZone);
    c.header('Content-Disposition', `attachment; filename="bookshelf-backup-${day}.json"`);
    return respond(c, backupEnvelopeSchema, envelope);
  });

  app.post(
    '/backup/import',
    bodyLimit({
      maxSize: MAX_IMPORT_BYTES,
      onError: () => {
        throw new AppError(400, 'validation_error', 'Backup file is too large');
      },
    }),
    async (c) =>
      respond(
        c,
        backupImportResponseSchema,
        importBackup(ctx, await readJson(c, backupEnvelopeSchema)),
      ),
  );

  app.post('/backup/notion', async (c) => respond(c, notionRunResultSchema, await notion.run()));
  app.get('/backup/notion/status', (c) => respond(c, notionStatusSchema, notion.status()));

  return app;
}
