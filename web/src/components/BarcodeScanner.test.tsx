import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  BarcodeScanner,
  cameraErrorMessage,
  defaultScannerDeps,
  isbnFromBarcode,
  type ScannerDeps,
} from './BarcodeScanner.tsx';

function fakeStream() {
  const stop = vi.fn();
  return { stream: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop };
}

function deps(overrides: Partial<ScannerDeps> = {}): ScannerDeps {
  return {
    isSecureContext: () => true,
    getUserMedia: () => Promise.resolve(fakeStream().stream),
    loadDecoder: () => Promise.resolve(() => Promise.resolve([])),
    captureFrame: () => ({}) as ImageData,
    ...overrides,
  };
}

describe('isbnFromBarcode', () => {
  it('accepts valid Bookland EAN-13s only', () => {
    expect(isbnFromBarcode('9781526622426')).toBe('9781526622426');
    expect(isbnFromBarcode('978-0-441-47812-5')).toBe('9780441478125');
    expect(isbnFromBarcode('5012345678900')).toBeNull();
    expect(isbnFromBarcode('9781526622427')).toBeNull();
  });
});

describe('cameraErrorMessage', () => {
  it.each([
    ['NotAllowedError', /blocked/],
    ['NotFoundError', /No suitable camera/],
    ['NotReadableError', /in use/],
    ['Other', /could not be started/],
  ])('explains %s', (name, message) => {
    expect(cameraErrorMessage(new DOMException('x', name))).toMatch(message);
  });
});

describe('BarcodeScanner', () => {
  it('explains that the camera needs HTTPS', () => {
    render(<BarcodeScanner onDetected={vi.fn()} deps={deps({ isSecureContext: () => false })} />);
    expect(screen.getByRole('note')).toHaveTextContent('secure (HTTPS) connection');
  });

  it('explains when the browser has no camera API', () => {
    render(<BarcodeScanner onDetected={vi.fn()} deps={deps({ getUserMedia: null })} />);
    expect(screen.getByRole('note')).toHaveTextContent('can’t use the camera');
  });

  it('reports a denied permission and falls back to typing', async () => {
    render(
      <BarcodeScanner
        onDetected={vi.fn()}
        deps={deps({
          getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera access was blocked');
  });

  it('decodes frames until a valid ISBN appears, then stops the camera', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { stream, stop } = fakeStream();
    const decode = vi
      .fn<(image: ImageData) => Promise<string[]>>()
      .mockResolvedValueOnce(['5012345678900'])
      .mockResolvedValue(['9781526622426']);
    const captureFrame = vi
      .fn<ScannerDeps['captureFrame']>()
      .mockReturnValueOnce(null)
      .mockReturnValue({} as ImageData);
    const onDetected = vi.fn();
    render(
      <BarcodeScanner
        onDetected={onDetected}
        deps={deps({
          getUserMedia: () => Promise.resolve(stream),
          loadDecoder: () => Promise.resolve(decode),
          captureFrame,
        })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByText(/Point the camera/)).toBeInTheDocument();
    await waitFor(() => {
      expect(onDetected).toHaveBeenCalledWith('9781526622426');
    });
    expect(stop).toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('can be stopped by the user', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { stream, stop } = fakeStream();
    render(
      <BarcodeScanner
        onDetected={vi.fn()}
        deps={deps({ getUserMedia: () => Promise.resolve(stream) })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop camera' }));
    expect(stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Scan barcode' })).toBeInTheDocument();
  });

  it('has browser defaults that report the environment', () => {
    expect(() => defaultScannerDeps.isSecureContext()).not.toThrow();
    const video = document.createElement('video');
    expect(defaultScannerDeps.captureFrame(video)).toBeNull();
  });
});
