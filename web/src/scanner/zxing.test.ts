import { describe, expect, it, vi } from 'vitest';

const { prepareZXingModule, readBarcodes } = vi.hoisted(() => ({
  prepareZXingModule: vi.fn(),
  readBarcodes: vi.fn(),
}));

vi.mock('zxing-wasm/reader', () => ({ prepareZXingModule, readBarcodes }));

describe('zxing adapter', () => {
  it('serves the wasm from our own origin and returns only valid EAN-13 reads', async () => {
    const { decodeEan13 } = await import('./zxing.ts');
    const options = prepareZXingModule.mock.calls[0]?.[0] as {
      overrides: { locateFile: (path: string, prefix: string) => string };
    };
    const wasm = options.overrides.locateFile('zxing_reader.wasm', 'https://cdn.example/');
    expect(wasm).toMatch(/zxing_reader\.wasm/);
    expect(wasm).not.toMatch(/^https?:/);
    expect(options.overrides.locateFile('other.js', '/base/')).toBe('/base/other.js');

    readBarcodes.mockResolvedValue([
      { isValid: true, text: '9781526622426' },
      { isValid: false, text: '978' },
    ]);
    const image = {} as ImageData;
    await expect(decodeEan13(image)).resolves.toEqual(['9781526622426']);
    expect(readBarcodes).toHaveBeenCalledWith(
      image,
      expect.objectContaining({ formats: ['EAN13'] }),
    );
  });
});
