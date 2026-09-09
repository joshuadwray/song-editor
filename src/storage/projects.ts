/**
 * Project persistence.
 *
 * A project is a small JSON document plus the encoded audio it references.
 * Both live under `projects/<id>/` so deleting a project removes everything it
 * owns — no reference counting, nothing to leak, nothing to garbage collect.
 * Duplicating a source across two projects costs a few megabytes; getting
 * cleanup wrong costs her work.
 */

import { APP_NAME } from '../../app.config';
import { Project, projectDuration } from '../model/project';
import { hasOpfs, listDir, readFile, removeEntry, writeFile } from './opfs';

/** Bumped only for changes the loader cannot read. Guards future migrations. */
export const FORMAT_VERSION = 1;

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  trackCount: number;
  duration: number;
}

interface StoredProject extends ProjectSummary {
  version: number;
  project: Project;
}

/**
 * Everything this app stores lives under one directory.
 *
 * Browser storage is scoped to the *origin*, not the path — so on GitHub Pages
 * every app under `<user>.github.io` shares one OPFS filesystem. Namespacing
 * keeps a neighbouring app from ever colliding with her projects.
 *
 * NEVER CHANGE THIS STRING. It is the key to every saved project, and it is
 * deliberately unrelated to the repository name or the app's display name so
 * that renaming either cannot orphan her work. Storage survives a repo rename
 * precisely because the origin and this key both stay put.
 */
const APP_DIR = 'song-editor';

const dirFor = (id: string) => `${APP_DIR}/projects/${id}`;
const jsonPath = (id: string) => `${dirFor(id)}/project.json`;
const sourcePath = (projectId: string, sourceId: string) =>
  `${dirFor(projectId)}/sources/${sourceId}`;

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveProject(id: string, name: string, project: Project): Promise<void> {
  if (!hasOpfs()) throw new Error('This browser cannot store projects.');
  const stored: StoredProject = {
    version: FORMAT_VERSION,
    id,
    name,
    updatedAt: Date.now(),
    trackCount: project.tracks.length,
    duration: projectDuration(project),
    project,
  };
  await writeFile(jsonPath(id), JSON.stringify(stored));
}

export async function loadProject(
  id: string,
): Promise<{ name: string; project: Project } | null> {
  const file = await readFile(jsonPath(id));
  if (!file) return null;
  try {
    const stored = JSON.parse(await file.text()) as StoredProject;
    if (stored.version > FORMAT_VERSION) {
      throw new Error(
        `This project was saved by a newer version of ${APP_NAME} and cannot be opened.`,
      );
    }
    return { name: stored.name, project: stored.project };
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('This project file is damaged.');
    throw err;
  }
}

/** Newest first. A project whose file is unreadable is skipped, not fatal. */
export async function listProjects(): Promise<ProjectSummary[]> {
  if (!hasOpfs()) return [];
  const ids = await listDir(`${APP_DIR}/projects`);
  const summaries: ProjectSummary[] = [];
  for (const id of ids) {
    const file = await readFile(jsonPath(id));
    if (!file) continue;
    try {
      const stored = JSON.parse(await file.text()) as StoredProject;
      summaries.push({
        id,
        name: stored.name,
        updatedAt: stored.updatedAt,
        trackCount: stored.trackCount,
        duration: stored.duration,
      });
    } catch {
      // A damaged entry should not hide the projects that are still fine.
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  await removeEntry(dirFor(id));
}

/** Keep the original encoded file, not the decoded samples. */
export async function storeSource(
  projectId: string,
  sourceId: string,
  data: Blob,
): Promise<void> {
  await writeFile(sourcePath(projectId, sourceId), data);
}

export async function readSource(projectId: string, sourceId: string): Promise<File | null> {
  return readFile(sourcePath(projectId, sourceId));
}
