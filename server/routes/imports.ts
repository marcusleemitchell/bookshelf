/**
 * Import routes (SPEC §8): Bookpine CSV preview (dry run) and import into
 * the signed-in member's shelf (parents and admins only). The
 * CSV comes as a multipart upload (`file` field) or as the raw request body,
 * up to {@link MAX_BOOKPINE_CSV_BYTES}.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bookpineReportSchema, MAX_BOOKPINE_CSV_BYTES } from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import type { AuthEnv } from '../http/auth.ts';
import { validationError } from '../http/errors.ts';
import { respond } from '../http/validate.ts';
import { importBookpine, previewBookpine } from '../services/bookpine.ts';
import { parentsOnly, requestScope } from '../services/scope.ts';

const csvLimit = bodyLimit({
  maxSize: MAX_BOOKPINE_CSV_BYTES,
  onError: () => {
    throw validationError(
      `The CSV is larger than ${MAX_BOOKPINE_CSV_BYTES / (1024 * 1024)} MB; is it a Bookpine export?`,
    );
  },
});

/** The uploaded CSV text: a multipart `file` field, or the raw body. */
async function readCsv(c: Context): Promise<string> {
  const type = c.req.header('content-type') ?? '';
  let text: string;
  if (type.startsWith('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (typeof file === 'string') text = file;
    else if (file instanceof File) text = await file.text();
    else throw validationError('Attach the Bookpine CSV export as the "file" field');
  } else {
    text = await c.req.text();
  }
  if (text.trim() === '') throw validationError('Send the Bookpine CSV export in the request body');
  return text;
}

export function importRoutes(ctx: AppContext): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Parents and admins import into their own shelf (ADR 0010); checked before the upload is read.
  app.use('/import/*', parentsOnly('import from Bookpine'));
  app.post('/import/bookpine/preview', csvLimit, async (c) =>
    respond(c, bookpineReportSchema, await previewBookpine(ctx, requestScope(c), await readCsv(c))),
  );
  app.post('/import/bookpine', csvLimit, async (c) =>
    respond(c, bookpineReportSchema, await importBookpine(ctx, requestScope(c), await readCsv(c))),
  );
  return app;
}
