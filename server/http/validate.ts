/**
 * Request parsing and response validation helpers: every body, query and
 * response passes through a shared Zod schema ("Zod-validated both ways").
 */
import type { Context } from 'hono';
import type { z } from 'zod';
import { idSchema } from '../../shared/index.ts';
import { AppError, validationError } from './errors.ts';

function issues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function describe(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid request';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}

/** Parses and validates the JSON body. An empty body is treated as `{}`. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  let body: unknown;
  try {
    body = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    throw validationError('Request body must be valid JSON');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw validationError(describe(result.error), issues(result.error));
  return result.data;
}

/** Validates query-string parameters. */
export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw validationError(describe(result.error), issues(result.error));
  return result.data;
}

/** Validates a path parameter (a UUID unless another schema is given). */
export function readParam<S extends z.ZodType = typeof idSchema>(
  c: Context,
  name: string,
  schema?: S,
): z.output<S> {
  const result = (schema ?? idSchema).safeParse(c.req.param(name));
  if (!result.success) {
    throw validationError(`Invalid ${name}: ${describe(result.error)}`, issues(result.error));
  }
  return result.data as z.output<S>;
}

/**
 * Validates `data` against the response schema before sending it, so the
 * server can never drift from the shared contract unnoticed.
 */
export function respond<S extends z.ZodType>(
  c: Context,
  schema: S,
  data: z.input<S>,
  status: 200 | 201 = 200,
): Response {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      500,
      'internal_error',
      'Response failed contract validation',
      issues(result.error),
    );
  }
  return c.json(result.data as object, status);
}
