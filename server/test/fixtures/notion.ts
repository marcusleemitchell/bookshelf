/**
 * An in-memory fake of the parts of the Notion API (2022-06-28) Bookshelf
 * uses, wired into the test fetch mock. Response shapes follow Notion's.
 */
import { randomUUID } from 'node:crypto';
import { json, type FetchCall, type FetchMock } from '../helpers.ts';

export interface FakeDatabase {
  id: string;
  parentPageId: string;
  title: string;
  properties: Record<string, unknown>;
  archived: boolean;
}

export interface FakePage {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  archived: boolean;
}

export interface FakeNotion {
  databases: Map<string, FakeDatabase>;
  pages: Map<string, FakePage>;
  /** Requests handled, as `METHOD /path`. */
  log: string[];
  /** Responses to return instead of the normal handling, consumed in order. */
  queue: (Response | Error)[];
  /** Optional gate awaited before handling each request. */
  gate: Promise<void> | null;
  databaseByTitle(title: string): FakeDatabase | undefined;
  pagesIn(title: string): FakePage[];
}

function notFound(id: string): Response {
  return json(
    {
      object: 'error',
      status: 404,
      code: 'object_not_found',
      message: `Could not find object with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
    },
    404,
  );
}

function bookshelfId(properties: Record<string, unknown>): string | undefined {
  const prop = properties['Bookshelf ID'] as
    { rich_text?: { text: { content: string } }[] } | undefined;
  return prop?.rich_text?.map((t) => t.text.content).join('');
}

export function installFakeNotion(fetchMock: FetchMock): FakeNotion {
  const fake: FakeNotion = {
    databases: new Map(),
    pages: new Map(),
    log: [],
    queue: [],
    gate: null,
    databaseByTitle(title) {
      return [...this.databases.values()].find((db) => db.title === title && !db.archived);
    },
    pagesIn(title) {
      const db = this.databaseByTitle(title);
      return [...this.pages.values()].filter((p) => p.databaseId === db?.id && !p.archived);
    },
  };

  const handle = async (call: FetchCall): Promise<Response> => {
    if (fake.gate) await fake.gate;
    const path = new URL(call.url).pathname.replace(/^\/v1/, '');
    fake.log.push(`${call.method} ${path}`);
    const queued = fake.queue.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    const body = (call.body ?? {}) as Record<string, unknown>;

    if (call.method === 'POST' && path === '/databases') {
      const parent = body['parent'] as { page_id: string };
      const title = (body['title'] as { text: { content: string } }[])[0]?.text.content ?? '';
      const db: FakeDatabase = {
        id: randomUUID(),
        parentPageId: parent.page_id,
        title,
        properties: body['properties'] as Record<string, unknown>,
        archived: false,
      };
      fake.databases.set(db.id, db);
      return json({
        object: 'database',
        id: db.id,
        title: body['title'],
        properties: db.properties,
      });
    }
    let match = /^\/databases\/([^/]+)$/.exec(path);
    if (call.method === 'GET' && match) {
      const db = fake.databases.get(match[1] as string);
      if (!db) return notFound(match[1] as string);
      return json({ object: 'database', id: db.id, archived: db.archived, in_trash: db.archived });
    }
    match = /^\/databases\/([^/]+)\/query$/.exec(path);
    if (call.method === 'POST' && match) {
      const databaseId = match[1] as string;
      if (!fake.databases.has(databaseId)) return notFound(databaseId);
      const filter = body['filter'] as { rich_text: { equals: string } };
      const results = [...fake.pages.values()].filter(
        (p) =>
          p.databaseId === databaseId &&
          !p.archived &&
          bookshelfId(p.properties) === filter.rich_text.equals,
      );
      return json({
        object: 'list',
        results: results.map((p) => ({ object: 'page', id: p.id })),
        has_more: false,
      });
    }
    if (call.method === 'POST' && path === '/pages') {
      const parent = body['parent'] as { database_id: string };
      if (!fake.databases.has(parent.database_id)) return notFound(parent.database_id);
      const page: FakePage = {
        id: randomUUID(),
        databaseId: parent.database_id,
        properties: body['properties'] as Record<string, unknown>,
        archived: false,
      };
      fake.pages.set(page.id, page);
      return json({ object: 'page', id: page.id });
    }
    match = /^\/pages\/([^/]+)$/.exec(path);
    if (call.method === 'PATCH' && match) {
      const page = fake.pages.get(match[1] as string);
      if (!page || page.archived) return notFound(match[1] as string);
      if (body['properties']) page.properties = body['properties'] as Record<string, unknown>;
      if (body['archived'] === true) page.archived = true;
      return json({ object: 'page', id: page.id, archived: page.archived });
    }
    return json(
      {
        object: 'error',
        status: 400,
        code: 'invalid_request_url',
        message: 'Invalid request URL.',
      },
      400,
    );
  };

  fetchMock.on('https://api.notion.com/', handle);
  return fake;
}
