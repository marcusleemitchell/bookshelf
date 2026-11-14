/**
 * A tiny, dependency-free rasteriser and PNG encoder for the Bookshelf app
 * icons (an open book on a bookish green background). Uses only Node
 * built-ins (`node:zlib`). `scripts/generate-icons.ts` writes the files.
 */
import { crc32, deflateSync } from 'node:zlib';

export type Rgb = readonly [number, number, number];
export type Point = readonly [number, number];

/** A filled polygon in unit coordinates (0–1 on both axes, y downwards). */
export interface Shape {
  points: readonly Point[];
  colour: Rgb;
}

export const PALETTE = {
  background: [0x2f, 0x5d, 0x50],
  cover: [0xc9, 0x9a, 0x4b],
  page: [0xfb, 0xf7, 0xee],
  line: [0x9f, 0xb8, 0xae],
} as const satisfies Record<string, Rgb>;

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Text lines on a page: thin quads following the page's slant. */
function pageLines(left: boolean): Shape[] {
  const shapes: Shape[] = [];
  for (let i = 0; i < 4; i += 1) {
    const y = 0.45 + i * 0.065;
    // Pages slope towards the spine: the outer edge sits 0.06 higher.
    const outer = left ? 0.23 : 0.77;
    const inner = left ? 0.45 : 0.55;
    const outerY = y - 0.045;
    const innerY = y;
    const h = 0.016;
    shapes.push({
      colour: PALETTE.line,
      points: left
        ? [
            [outer, outerY],
            [inner, innerY],
            [inner, innerY + h],
            [outer, outerY + h],
          ]
        : [
            [inner, innerY],
            [outer, outerY],
            [outer, outerY + h],
            [inner, innerY + h],
          ],
    });
  }
  return shapes;
}

/** The open-book glyph, centred on (0.5, 0.5) and filling roughly 0.7 of the canvas. */
export function bookGlyph(): Shape[] {
  return [
    {
      colour: PALETTE.cover,
      points: [
        [0.13, 0.3],
        [0.5, 0.36],
        [0.87, 0.3],
        [0.87, 0.74],
        [0.5, 0.8],
        [0.13, 0.74],
      ],
    },
    {
      colour: PALETTE.page,
      points: [
        [0.17, 0.25],
        [0.49, 0.32],
        [0.49, 0.75],
        [0.17, 0.68],
      ],
    },
    {
      colour: PALETTE.page,
      points: [
        [0.51, 0.32],
        [0.83, 0.25],
        [0.83, 0.68],
        [0.51, 0.75],
      ],
    },
    ...pageLines(true),
    ...pageLines(false),
    { colour: PALETTE.cover, points: rect(0.49, 0.32, 0.51, 0.78) },
  ];
}

/** Scales shapes about the canvas centre (used to keep maskable icons in the safe zone). */
export function scaleShapes(shapes: readonly Shape[], factor: number): Shape[] {
  return shapes.map((shape) => ({
    colour: shape.colour,
    points: shape.points.map(([x, y]) => [0.5 + (x - 0.5) * factor, 0.5 + (y - 0.5) * factor]),
  }));
}

/** Even–odd point-in-polygon test. */
export function insidePolygon(points: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i] as Point;
    const [xj, yj] = points[j] as Point;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Rasterises shapes (painted in order over `background`) into an RGB buffer
 * of `size`×`size` pixels, anti-aliased with `samples`×`samples` supersampling.
 */
export function rasterise(
  size: number,
  background: Rgb,
  shapes: readonly Shape[],
  samples = 4,
): Uint8Array {
  const pixels = new Uint8Array(size * size * 3);
  const total = samples * samples;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          let colour: Rgb = background;
          for (const shape of shapes) {
            if (insidePolygon(shape.points, x, y)) colour = shape.colour;
          }
          r += colour[0];
          g += colour[1];
          b += colour[2];
        }
      }
      const offset = (py * size + px) * 3;
      pixels[offset] = Math.round(r / total);
      pixels[offset + 1] = Math.round(g / total);
      pixels[offset + 2] = Math.round(b / total);
    }
  }
  return pixels;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes an RGB buffer as a truecolour 8-bit PNG (no alpha). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new RangeError(`Expected ${width * height * 3} bytes of RGB data, got ${rgb.length}`);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // compression
  header[11] = 0; // filter method
  header[12] = 0; // no interlace
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

export interface IconSpec {
  file: string;
  size: number;
  /** Glyph scale: maskable icons keep the glyph inside the central safe zone. */
  glyphScale: number;
}

export const ICONS: readonly IconSpec[] = [
  { file: 'icon-192.png', size: 192, glyphScale: 1 },
  { file: 'icon-512.png', size: 512, glyphScale: 1 },
  // Maskable: platforms may crop to a circle of 80% diameter; keep the glyph within it.
  { file: 'icon-maskable-512.png', size: 512, glyphScale: 0.72 },
  { file: 'apple-touch-icon.png', size: 180, glyphScale: 0.9 },
];

/** Renders one icon to PNG bytes. */
export function renderIcon(spec: IconSpec): Buffer {
  const shapes = scaleShapes(bookGlyph(), spec.glyphScale);
  return encodePng(spec.size, spec.size, rasterise(spec.size, PALETTE.background, shapes));
}
