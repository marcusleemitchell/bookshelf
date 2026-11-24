import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ICONS,
  PALETTE,
  bookGlyph,
  encodePng,
  insidePolygon,
  rasterise,
  renderIcon,
  scaleShapes,
} from './icons.ts';

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): Chunk[] {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crc = png.readUInt32BE(offset + 8 + length);
    expect(crc).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

describe('insidePolygon', () => {
  const square = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const;
  it('detects points inside and outside', () => {
    expect(insidePolygon(square, 0.5, 0.5)).toBe(true);
    expect(insidePolygon(square, 1.5, 0.5)).toBe(false);
    expect(insidePolygon(square, 0.5, -0.1)).toBe(false);
  });
});

describe('scaleShapes', () => {
  it('scales about the centre', () => {
    const [shape] = scaleShapes(
      [
        {
          colour: PALETTE.page,
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
      0.5,
    );
    expect(shape?.points).toEqual([
      [0.25, 0.25],
      [0.75, 0.75],
    ]);
  });
});

describe('rasterise', () => {
  it('fills the background and paints shapes in order', () => {
    const pixels = rasterise(10, PALETTE.background, bookGlyph());
    // Corner pixel is pure background.
    expect([...pixels.subarray(0, 3)]).toEqual([...PALETTE.background]);
    // Centre of the left page is page-coloured.
    const x = 3;
    const y = 3;
    const offset = (y * 10 + x) * 3;
    expect([...pixels.subarray(offset, offset + 3)]).toEqual([...PALETTE.page]);
  });
});

describe('encodePng', () => {
  it('writes a valid truecolour PNG that round-trips the pixels', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
    const png = encodePng(2, 2, rgb);
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const header = chunks[0]?.data ?? Buffer.alloc(0);
    expect(header.readUInt32BE(0)).toBe(2);
    expect(header.readUInt32BE(4)).toBe(2);
    expect(header[8]).toBe(8);
    expect(header[9]).toBe(2);
    const raw = inflateSync(chunks[1]?.data ?? Buffer.alloc(0));
    expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 10, 20, 30]);
  });

  it('rejects a buffer of the wrong size', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow(RangeError);
  });
});

/**
 * Rendering a 512 px icon is CPU-bound and several times slower under
 * coverage with the whole suite running (over 5 s on a Mac mini).
 */
const RENDER_TIMEOUT_MS = 30_000;

describe('committed icons', () => {
  it.each(ICONS)(
    '$file matches the generator output',
    (spec) => {
      const committed = readFileSync(join(import.meta.dirname, '..', 'web', 'public', spec.file));
      const header = readChunks(committed)[0]?.data ?? Buffer.alloc(0);
      expect(header.readUInt32BE(0)).toBe(spec.size);
      expect(header.readUInt32BE(4)).toBe(spec.size);
      expect(committed.equals(renderIcon(spec))).toBe(true);
    },
    RENDER_TIMEOUT_MS,
  );
});
