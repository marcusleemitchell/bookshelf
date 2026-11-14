/**
 * RFC 4180 CSV parsing (SPEC §8): comma-separated fields, records ended by
 * CRLF, LF or CR, double-quoted fields that may contain commas, line breaks
 * and doubled quotes (`""`). A UTF-8 byte-order mark is ignored, and a final
 * line break does not start an empty record. Malformed quoting is reported
 * with its line number rather than guessed at. Blank lines between records
 * are skipped.
 */

export class CsvError extends Error {
  override readonly name = 'CsvError';
  /** 1-based line on which the problem was found. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.line = line;
  }
}

export interface CsvRecord {
  /** 1-based line on which the record starts. */
  line: number;
  fields: string[];
}

/** Parses CSV text into records. Throws {@link CsvError} on malformed quoting. */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let i = 0;
  // True once the current record has any content (a field separator or text).
  let started = false;

  const endField = () => {
    fields.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, fields });
    fields = [];
    started = false;
  };

  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"' && field === '') {
      // Quoted field: read until the closing quote.
      const quoteLine = line;
      started = true;
      i += 1;
      for (;;) {
        if (i >= text.length) throw new CsvError('Unterminated quoted field', quoteLine);
        const inner = text[i] as string;
        if (inner === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (inner === '\n' || (inner === '\r' && text[i + 1] !== '\n')) line += 1;
        field += inner;
        i += 1;
      }
      const next = text[i];
      if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
        throw new CsvError('Unexpected text after a closing quote', line);
      }
      continue;
    }
    if (char === ',') {
      started = true;
      endField();
      i += 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (started || field !== '' || fields.length > 0) endRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    if (char === '"') throw new CsvError('Unexpected quote inside an unquoted field', line);
    started = true;
    field += char;
    i += 1;
  }
  if (started || field !== '' || fields.length > 0) endRecord();
  return records;
}
