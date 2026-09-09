/**
 * Origin Private File System helpers.
 *
 * OPFS is where a project's audio lives between sittings. Storing the original
 * *encoded* bytes (a 5 MB mp3) rather than decoded samples (100 MB of floats)
 * keeps projects small, and referencing them by our own key means a project
 * survives the user moving, renaming, or deleting the file they imported.
 *
 * Requires a secure context, so every entry point degrades rather than throws.
 */

export function hasOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    window.isSecureContext
  );
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/** Walk (and optionally create) a slash-separated directory path. */
async function dirAt(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  let handle = await root();
  for (const segment of path.split('/').filter(Boolean)) {
    try {
      handle = await handle.getDirectoryHandle(segment, { create });
    } catch {
      return null;
    }
  }
  return handle;
}

function splitPath(path: string): { dir: string; name: string } {
  const parts = path.split('/').filter(Boolean);
  return { name: parts.pop() ?? '', dir: parts.join('/') };
}

export async function writeFile(path: string, data: Blob | string): Promise<void> {
  const { dir, name } = splitPath(path);
  const handle = await dirAt(dir, true);
  if (!handle) throw new Error(`Could not open storage directory "${dir}".`);
  const file = await handle.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(data);
  } finally {
    // Close even on failure, or the file is left locked for the session.
    await writable.close();
  }
}

/** Returns null when the entry does not exist — a missing file is not an error. */
export async function readFile(path: string): Promise<File | null> {
  const { dir, name } = splitPath(path);
  const handle = await dirAt(dir, false);
  if (!handle) return null;
  try {
    return await (await handle.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function removeEntry(path: string, recursive = true): Promise<void> {
  const { dir, name } = splitPath(path);
  const handle = await dirAt(dir, false);
  if (!handle) return;
  try {
    await handle.removeEntry(name, { recursive });
  } catch {
    // Already gone.
  }
}

export async function listDir(path: string): Promise<string[]> {
  const handle = await dirAt(path, false);
  if (!handle) return [];
  const names: string[] = [];
  for await (const [name] of handle.entries()) names.push(name);
  return names;
}

/**
 * Ask Chrome not to evict this origin's storage under disk pressure.
 *
 * Without it a project can be discarded silently, which is the worst failure
 * this app could have. Chrome grants it readily for an installed PWA.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!hasOpfs() || typeof navigator.storage.persist !== 'function') return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!hasOpfs() || typeof navigator.storage.estimate !== 'function') return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
