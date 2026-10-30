import { stat } from 'node:fs/promises';

/** Device-link creates must not persist a path that does not exist on this computer. */
export async function remoteCreateWorkingDirError(dir: unknown): Promise<string | null> {
  if (typeof dir !== 'string' || !dir.trim()) return null;
  const trimmed = dir.trim();
  try {
    const info = await stat(trimmed);
    if (!info.isDirectory()) return `invalid workingDir: not a directory on this computer: ${trimmed}`;
    return null;
  } catch {
    return `invalid workingDir: does not exist on this computer: ${trimmed}`;
  }
}
