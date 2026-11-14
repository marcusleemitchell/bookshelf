import { describe, expect, it } from 'vitest';
import {
  cleanIsbn,
  isbn10To13,
  isbn13To10,
  isValidIsbn10,
  isValidIsbn13,
  normaliseIsbn,
} from './isbn.ts';

describe('cleanIsbn', () => {
  it.each([
    ['978-0-306-40615-7', '9780306406157'],
    [' 0 306 40615 2 ', '0306406152'],
    ['080442957x', '080442957X'],
    ['ISBN 978-0-306-40615-7', '9780306406157'],
    ['ISBN-13: 978-0-306-40615-7', '9780306406157'],
    ['isbn-10:0306406152', '0306406152'],
    ['978‐0‐306‐40615‐7', '9780306406157'],
  ])('cleans %s', (input, expected) => {
    expect(cleanIsbn(input)).toBe(expected);
  });
});

describe('isValidIsbn10', () => {
  it.each(['0306406152', '080442957X', '0141036141', '0747532699'])('accepts %s', (isbn) => {
    expect(isValidIsbn10(isbn)).toBe(true);
  });
  it.each(['0306406153', '030640615', '03064061521', 'X306406152', '080442957x', ''])(
    'rejects %s',
    (isbn) => {
      expect(isValidIsbn10(isbn)).toBe(false);
    },
  );
});

describe('isValidIsbn13', () => {
  it.each(['9780306406157', '9780804429573', '9791090636071', '9780141036144'])(
    'accepts %s',
    (isbn) => {
      expect(isValidIsbn13(isbn)).toBe(true);
    },
  );
  it.each(['9780306406158', '1234567890128', '978030640615', '97803064061577', 'abc'])(
    'rejects %s',
    (isbn) => {
      expect(isValidIsbn13(isbn)).toBe(false);
    },
  );
});

describe('conversions', () => {
  it('converts ISBN-10 to ISBN-13', () => {
    expect(isbn10To13('0306406152')).toBe('9780306406157');
    expect(isbn10To13('080442957X')).toBe('9780804429573');
  });

  it('converts ISBN-13 to ISBN-10, including an X check digit', () => {
    expect(isbn13To10('9780306406157')).toBe('0306406152');
    expect(isbn13To10('9780804429573')).toBe('080442957X');
  });

  it('returns null for 979 ISBN-13s, which have no ISBN-10', () => {
    expect(isbn13To10('9791090636071')).toBeNull();
  });

  it('throws on invalid input', () => {
    expect(() => isbn10To13('0306406153')).toThrow('Invalid ISBN-10');
    expect(() => isbn13To10('9780306406158')).toThrow('Invalid ISBN-13');
  });

  it('round-trips', () => {
    for (const isbn10 of ['0306406152', '080442957X', '0141036141']) {
      expect(isbn13To10(isbn10To13(isbn10))).toBe(isbn10);
    }
  });
});

describe('normaliseIsbn', () => {
  it('normalises an ISBN-10 with hyphens', () => {
    expect(normaliseIsbn('0-306-40615-2')).toEqual({
      isbn10: '0306406152',
      isbn13: '9780306406157',
    });
  });

  it('normalises an ISBN-13', () => {
    expect(normaliseIsbn('978 0 306 40615 7')).toEqual({
      isbn10: '0306406152',
      isbn13: '9780306406157',
    });
  });

  it('normalises a 979 ISBN-13 without an ISBN-10', () => {
    expect(normaliseIsbn('979-10-90636-07-1')).toEqual({ isbn10: null, isbn13: '9791090636071' });
  });

  it.each(['', 'not an isbn', '0306406153', '9780306406158', '12345'])('rejects %j', (input) => {
    expect(normaliseIsbn(input)).toBeNull();
  });
});
