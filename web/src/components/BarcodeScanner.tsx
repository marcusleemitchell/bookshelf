/**
 * Camera barcode scanner for book ISBNs (SPEC §6.3). Uses the rear camera via
 * `getUserMedia` (HTTPS only) and zxing-wasm to read EAN-13 barcodes; only
 * Bookland codes (978/979) that are valid ISBN-13s are accepted. When the
 * camera is unavailable it explains why, and the user types the ISBN instead.
 */
import { useEffect, useRef, useState } from 'react';
import { normaliseIsbn } from '../../../shared/index.ts';
import { CameraIcon } from './Icons.tsx';

/** The ISBN-13 in a scanned EAN-13, or null when it is not a valid Bookland code. */
export function isbnFromBarcode(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  if (!/^97[89]\d{10}$/.test(digits)) return null;
  return normaliseIsbn(digits)?.isbn13 ?? null;
}

export type Decoder = (image: ImageData) => Promise<string[]>;

export interface ScannerDeps {
  isSecureContext: () => boolean;
  getUserMedia: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null;
  loadDecoder: () => Promise<Decoder>;
  /** Grabs the central band of the current video frame, or null when not ready. */
  captureFrame: (video: HTMLVideoElement) => ImageData | null;
}

function captureFrame(video: HTMLVideoElement): ImageData | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  // Barcodes are wide and short: decode the middle 40% band at full width.
  const bandHeight = Math.round(height * 0.4);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = bandHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(
    video,
    0,
    (height - bandHeight) / 2,
    width,
    bandHeight,
    0,
    0,
    width,
    bandHeight,
  );
  return context.getImageData(0, 0, width, bandHeight);
}

export const defaultScannerDeps: ScannerDeps = {
  isSecureContext: () => window.isSecureContext,
  getUserMedia:
    typeof navigator !== 'undefined' && 'mediaDevices' in navigator
      ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
      : null,
  loadDecoder: async () => (await import('../scanner/zxing.ts')).decodeEan13,
  captureFrame,
};

/** How often a frame is decoded while scanning. */
export const SCAN_INTERVAL_MS = 250;

type ScanState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'error'; message: string };

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site (on iPhone: Settings → Apps → Safari → Camera), or type the ISBN instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No suitable camera was found. Type the ISBN instead.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it and try again, or type the ISBN instead.';
    default:
      return 'The camera could not be started. Type the ISBN instead.';
  }
}

export function BarcodeScanner({
  onDetected,
  deps = defaultScannerDeps,
}: {
  onDetected: (isbn13: string) => void;
  deps?: ScannerDeps;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const secure = deps.isSecureContext();
  const supported = deps.getUserMedia !== null;

  const stop = () => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  };

  useEffect(() => stop, []);

  const start = async () => {
    if (!deps.getUserMedia) return;
    setState({ kind: 'starting' });
    try {
      const [decode, stream] = await Promise.all([
        deps.loadDecoder(),
        deps.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }),
      ]);
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      setState({ kind: 'scanning' });
      const tick = async () => {
        const frame = deps.captureFrame(video);
        const texts = frame ? await decode(frame) : [];
        if (streamRef.current === null) return;
        for (const text of texts) {
          const isbn = isbnFromBarcode(text);
          if (isbn) {
            stop();
            setState({ kind: 'idle' });
            onDetected(isbn);
            return;
          }
        }
        timeoutRef.current = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
      };
      void tick();
    } catch (error) {
      stop();
      setState({ kind: 'error', message: cameraErrorMessage(error) });
    }
  };

  if (!secure) {
    return (
      <p className="card" role="note">
        The camera only works over a secure (HTTPS) connection. Open Bookshelf through its HTTPS
        address (Tailscale) to scan barcodes, or type the ISBN instead.
      </p>
    );
  }
  if (!supported) {
    return (
      <p className="card" role="note">
        This browser can’t use the camera. Type the ISBN instead.
      </p>
    );
  }

  const active = state.kind === 'scanning' || state.kind === 'starting';
  return (
    <div className="stack-sm">
      <div className="scanner" hidden={!active}>
        <video ref={videoRef} playsInline muted aria-label="Camera preview" />
        <div className="scanner-guide" aria-hidden="true" />
      </div>
      {state.kind === 'scanning' && (
        <p className="small muted" role="status">
          Point the camera at the barcode on the back of the book.
        </p>
      )}
      {state.kind === 'error' && (
        <p className="error-text" role="alert">
          {state.message}
        </p>
      )}
      {active ? (
        <button
          type="button"
          className="btn"
          onClick={() => {
            stop();
            setState({ kind: 'idle' });
          }}
        >
          Stop camera
        </button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => void start()}>
          <CameraIcon /> Scan barcode
        </button>
      )}
    </div>
  );
}
