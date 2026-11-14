/**
 * Outbound HTTP helpers. Requests carry a timeout and an identifying
 * User-Agent; log-safe descriptions omit query strings (which may hold keys).
 */
import type { AppContext } from '../context.ts';

export const USER_AGENT = 'Bookshelf/1 (personal self-hosted reading tracker)';

/** `host/path` of a URL, without the query string. */
export function describeUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`;
}

export class OutboundError extends Error {
  override readonly name = 'OutboundError';
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/** Fetches `url`, throwing {@link OutboundError} on network failure, timeout or non-2xx status. */
export async function fetchOk(
  ctx: Pick<AppContext, 'fetch'>,
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      ...init,
      headers: {
        'User-Agent': USER_AGENT,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OutboundError(`Request to ${describeUrl(url)} failed: ${reason}`, null);
  }
  if (!response.ok) {
    throw new OutboundError(
      `Request to ${describeUrl(url)} failed with HTTP ${response.status}`,
      response.status,
    );
  }
  return response;
}

/** Fetches and parses JSON (see {@link fetchOk}). */
export async function fetchJson(
  ctx: Pick<AppContext, 'fetch'>,
  url: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const response = await fetchOk(ctx, url, { headers: { Accept: 'application/json' } }, timeoutMs);
  try {
    return await response.json();
  } catch {
    throw new OutboundError(
      `Response from ${describeUrl(url)} was not valid JSON`,
      response.status,
    );
  }
}
