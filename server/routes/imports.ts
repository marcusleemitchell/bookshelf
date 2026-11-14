/**
 * Import routes (SPEC §8): Bookpine CSV preview (dry run) and import. The
 * CSV comes as a multipart upload (`file` field) or as the raw request body,
 * up to {@link MAX_BOOKPINE_CSV_BYTES}.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bookpineReportSchema, MAX_BOOKPINE_CSV_BYTES } from '../../shared/index.ts';
import type { AppContext } from '../context.ts';
import { validationError } from '../http/errors.ts';
import { respond } from '../http/validate.ts';
import { importBookpine, previewBookpine } from '../services/bookpine.ts';

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

export function importRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.post('/import/bookpine/preview', csvLimit, async (c) =>
    respond(c, bookpineReportSchema, await previewBookpine(ctx, await readCsv(c))),
  );
  app.post('/import/bookpine', csvLimit, async (c) =>
    respond(c, bookpineReportSchema, await importBookpine(ctx, await readCsv(c))),
  );
  return app;
}
