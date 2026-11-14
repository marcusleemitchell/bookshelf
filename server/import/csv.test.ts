import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv.ts';

const fields = (text: string) => parseCsv(text).map((record) => record.fields);

describe('parseCsv (RFC 4180)', () => {
  it('splits records and fields', () => {
    expect(fields('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('accepts CRLF, LF and CR record endings, with or without a final line break', () => {
    expect(fields('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(fields('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(fields('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty fields, including trailing ones and empty quoted fields', () => {
    expect(fields('a,,c,\n,"",x\n')).toEqual([
      ['a', '', 'c', ''],
      ['', '', 'x'],
    ]);
    expect(fields('""\n')).toEqual([['']]);
    expect(fields(',\n')).toEqual([['', '']]);
  });

  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    const text = 'id,text\n1,"Hello, ""world""\nsecond line\r\nthird"\n2,plain\n';
    const records = parseCsv(text);
    expect(records.map((r) => r.fields)).toEqual([
      ['id', 'text'],
      ['1', 'Hello, "world"\nsecond line\r\nthird'],
      ['2', 'plain'],
    ]);
    // Line numbers count the line breaks inside quoted fields.
    expect(records.map((r) => r.line)).toEqual([1, 2, 5]);
  });

  it('ignores a byte-order mark and blank lines, and keeps non-ASCII text', () => {
    expect(fields('﻿slug,title\n\nx,书名 — Café\n\n')).toEqual([
      ['slug', 'title'],
      ['x', '书名 — Café'],
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  it('reports malformed quoting with its line', () => {
    expect(() => parseCsv('a,b\n1,"open\nstill open')).toThrow(
      new CsvError('Unterminated quoted field', 2),
    );
    expect(() => parseCsv('a\n"closed"x\n')).toThrow(
      /Unexpected text after a closing quote \(line 2\)/,
    );
    expect(() => parseCsv('a\nab"c\n')).toThrow(
      /Unexpected quote inside an unquoted field \(line 2\)/,
    );
    try {
      parseCsv('"x');
    } catch (error) {
      expect(error).toBeInstanceOf(CsvError);
      expect((error as CsvError).line).toBe(1);
    }
  });
});
