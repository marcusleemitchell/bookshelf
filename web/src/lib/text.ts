/** Small text helpers for form fields. */

/** Splits a comma-separated field ("Ann Leckie, Ursula K. Le Guin") into trimmed, non-empty parts. */
export function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
