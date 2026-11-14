import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from './logger.ts';

function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    now: () => new Date('2026-11-14T12:00:00.000Z'),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    ...options,
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes JSON lines with time, level and fields', () => {
    const { logger, lines } = capture();
    logger.info('hello', { path: '/api/health', status: 200 });
    expect(lines).toEqual([
      {
        time: '2026-11-14T12:00:00.000Z',
        level: 'info',
        msg: 'hello',
        path: '/api/health',
        status: 200,
      },
    ]);
  });

  it('filters by level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l['level'])).toEqual(['warn', 'error']);
    const silent = capture({ level: 'silent' });
    silent.logger.error('nothing');
    expect(silent.lines).toEqual([]);
  });

  it('redacts secret-looking keys and known secret values', () => {
    const { logger, lines } = capture({ level: 'debug', secrets: ['ntn_supersecret'] });
    logger.debug('calling https://api/x?key=ntn_supersecret', {
      headers: { Authorization: 'Bearer abc', 'Notion-Version': '2022-06-28' },
      token: 'abc',
      apiKey: 'abc',
      nested: [{ note: 'token is ntn_supersecret' }],
    });
    expect(lines[0]).toEqual({
      time: '2026-11-14T12:00:00.000Z',
      level: 'debug',
      msg: `calling https://api/x?key=${REDACTED}`,
      headers: { Authorization: REDACTED, 'Notion-Version': '2022-06-28' },
      token: REDACTED,
      apiKey: REDACTED,
      nested: [{ note: `token is ${REDACTED}` }],
    });
  });

  it('serialises errors without stacks and truncates deep objects', () => {
    const { logger, lines } = capture();
    logger.error('failed', {
      error: new TypeError('bad ntn_x'),
      deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
    });
    expect(lines[0]?.['error']).toEqual({ name: 'TypeError', message: 'bad ntn_x' });
    expect(lines[0]?.['deep']).toEqual({ a: { b: { c: { d: '[Truncated]' } } } });
  });

  it('binds fields in child loggers', () => {
    const { logger, lines } = capture();
    logger.child({ requestId: 'r1' }).child({ step: 2 }).warn('child');
    expect(lines[0]).toMatchObject({ requestId: 'r1', step: 2, msg: 'child' });
  });

  it('writes to stdout by default', () => {
    const logger = createLogger({ level: 'silent' });
    expect(() => {
      logger.info('quiet');
    }).not.toThrow();
  });
});
