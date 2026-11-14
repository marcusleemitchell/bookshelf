/**
 * Client-generated record IDs (SPEC §3: UUID v4, created by whoever creates
 * the record, which offline creation and idempotent sync rely on).
 */

function fromRandomBytes(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A new UUID v4. `crypto.randomUUID` only exists in secure contexts, so fall
 * back to `getRandomValues` (available everywhere) when it is missing.
 */
export function newId(): string {
  const randomUUID = (crypto as Partial<Crypto>).randomUUID;
  return randomUUID ? randomUUID.call(crypto) : fromRandomBytes();
}

export const testing = { fromRandomBytes };
