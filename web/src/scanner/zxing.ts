/**
 * zxing-wasm reader, loaded lazily by the barcode scanner. The `.wasm` file
 * is bundled by Vite and served from our own origin (precached by the
 * service worker), so scanning makes no third-party requests and works
 * offline.
 */
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? wasmUrl : prefix + path,
  },
});

/** Decodes EAN-13 barcodes in a video frame; returns their texts. */
export async function decodeEan13(image: ImageData): Promise<string[]> {
  const results = await readBarcodes(image, {
    formats: ['EAN13'],
    tryHarder: true,
    maxNumberOfSymbols: 1,
  });
  return results.filter((result) => result.isValid).map((result) => result.text);
}
