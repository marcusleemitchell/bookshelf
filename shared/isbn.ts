/**
 * ISBN-10 / ISBN-13 cleaning, validation and conversion.
 *
 * All functions are pure. "Clean" ISBNs contain only digits (plus a trailing
 * upper-case `X` check digit for ISBN-10).
 */

/** Strips spaces, hyphens and an optional `ISBN`/`ISBN-13:` prefix; upper-cases `x`. */
export function cleanIsbn(input: string): string {
  return input
    .trim()
    .replace(/^isbn(?:-1[03])?:?/i, '')
    .replace(/[\s‐-―-]/g, '')
    .toUpperCase();
}

/** True when `isbn` is a clean ISBN-10 with a correct check digit. */
export function isValidIsbn10(isbn: string): boolean {
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = isbn.charAt(i);
    const value = char === 'X' ? 10 : Number(char);
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

/** True when `isbn` is a clean ISBN-13 (978/979 prefix) with a correct check digit. */
export function isValidIsbn13(isbn: string): boolean {
  if (!/^97[89]\d{10}$/.test(isbn)) return false;
  return isbn13CheckDigit(isbn.slice(0, 12)) === isbn.charAt(12);
}

function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(first12.charAt(i)) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

function isbn10CheckDigit(first9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(first9.charAt(i)) * (10 - i);
  }
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? 'X' : String(check);
}

/** Converts a valid clean ISBN-10 to ISBN-13. Throws on invalid input. */
export function isbn10To13(isbn10: string): string {
  if (!isValidIsbn10(isbn10)) {
    throw new Error(`Invalid ISBN-10: ${isbn10}`);
  }
  const first12 = `978${isbn10.slice(0, 9)}`;
  return first12 + isbn13CheckDigit(first12);
}

/**
 * Converts a valid clean ISBN-13 to ISBN-10. Returns null for 979-prefixed
 * ISBNs, which have no ISBN-10 equivalent. Throws on invalid input.
 */
export function isbn13To10(isbn13: string): string | null {
  if (!isValidIsbn13(isbn13)) {
    throw new Error(`Invalid ISBN-13: ${isbn13}`);
  }
  if (!isbn13.startsWith('978')) return null;
  const first9 = isbn13.slice(3, 12);
  return first9 + isbn10CheckDigit(first9);
}

export interface NormalisedIsbn {
  isbn10: string | null;
  isbn13: string;
}

/**
 * Cleans and validates any ISBN-10/13 input and returns both forms.
 * Returns null when the input is not a valid ISBN.
 */
export function normaliseIsbn(input: string): NormalisedIsbn | null {
  const clean = cleanIsbn(input);
  if (isValidIsbn13(clean)) {
    return { isbn13: clean, isbn10: isbn13To10(clean) };
  }
  if (isValidIsbn10(clean)) {
    return { isbn10: clean, isbn13: isbn10To13(clean) };
  }
  return null;
}
