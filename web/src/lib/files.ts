/**
 * Saving and reading files in the browser. On iPhone the share sheet is the
 * natural way to keep a backup (Save to Files, AirDrop…); elsewhere the file
 * is downloaded.
 */

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled';

/** Offers `text` as a file via the share sheet when files can be shared, else downloads it. */
export async function saveTextFile(
  filename: string,
  text: string,
  type = 'application/json',
): Promise<SaveOutcome> {
  const file = new File([text], filename, { type });
  if ('canShare' in navigator && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      // Sharing failed for another reason: fall back to a download.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return 'downloaded';
}

/** Reads a picked file as text. */
export function readFileText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('The file could not be read'));
    };
    reader.readAsText(file);
  });
}
