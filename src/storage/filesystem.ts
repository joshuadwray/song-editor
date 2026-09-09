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

/** Returns false when the user cancels the save dialog. */
export async function saveBlob(
  blob: Blob,
  suggestedName: string,
  accept: Record<string, string[]>,
): Promise<boolean> {
  if (hasFileSystemAccess()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Audio file', accept }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      throw err;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
