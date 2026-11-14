/**
 * Writes the PWA / Home Screen icons into `web/public/`.
 * Run with `npm run icons` after changing the glyph in `scripts/icons.ts`;
 * the generated PNGs are committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICONS, renderIcon } from './icons.ts';

const outDir = join(import.meta.dirname, '..', 'web', 'public');
mkdirSync(outDir, { recursive: true });
for (const spec of ICONS) {
  const path = join(outDir, spec.file);
  writeFileSync(path, renderIcon(spec));
  process.stdout.write(`Wrote ${path}\n`);
}
