/**
 * File access.
 *
 * On ChromeOS the File System Access API reaches the real Files app, including
 * Google Drive, so "Save" overwrites in place like a desktop app instead of
 * dropping another copy in Downloads. Every call falls back to the classic
 * input/anchor approach if the API is unavailable.
 */

const AUDIO_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Audio files',
    accept: {
      'audio/*': ['.mp3', '.wav', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.webm'],
    },
  },
];

export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

/** Returns [] when the user cancels — cancelling is not an error. */
export async function openAudioFiles(): Promise<File[]> {
  if (!hasFileSystemAccess()) return openViaInput();
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      types: AUDIO_TYPES,
      excludeAcceptAllOption: false,
    });
    return Promise.all(handles.map((h) => h.getFile()));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return [];
    throw err;
  }
}

function openViaInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.multiple = true;
    input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
    // A cancelled picker fires no event in some browsers; the promise simply
    // never settles, which is harmless here since nothing awaits it forever.
    input.click();
  });
}

/**
 * Ask where to save, before the file exists.
 *
 * Deliberately separate from writing. `showSaveFilePicker` requires transient
 * user activation, which expires a few seconds after the click that granted it,
 * so it has to be called before any slow work — rendering and encoding a song
 * take far longer than the activation lasts. Callers must invoke this with no
 * `await` between the click and this call.
 *
 * Returns null when the user cancels, which is an ordinary outcome rather than
 * an error.
 */
export async function pickSaveFile(
  suggestedName: string,
  accept: Record<string, string[]>,
): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Audio file', accept }],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Write to a handle obtained earlier from pickSaveFile. */
export async function writeToFile(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    // Close even on failure, or the file is left locked for the session.
    await writable.close();
  }
}

/**
 * Fallback for browsers without the File System Access API: hand the file to
 * the download manager. No picker is involved, so this is safe to call after
 * the encode has finished.
 */
export function downloadBlob(blob: Blob, suggestedName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
