import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  GHOST_HANDOFF_QUOTA_BYTES,
  GHOST_HANDOFF_QUOTA_FILES,
  GHOST_HANDOFF_REF_RE,
  GHOST_HANDOFF_TTL_MS,
  type GhostHandoffFile,
} from '../../shared/ghost.js';
import { mediaTypeForLibraryPath } from './runtime/ghostFiles.js';

/**
 * Host-owned copies of chat files handed to a plugin (`handoff:<uuid>`).
 * Layout: `<root>/<instance>/<uuid>/{blob,meta.json}`. Writes land in
 * `<instance>/.tmp/<uuid>` and become visible by one directory rename, so a
 * crash leaves only `.tmp` leftovers for the next sweep. Copies are transient:
 * an unreadable or expired entry is deleted, never repaired.
 */
const TMP = '.tmp';
const STALE_TMP_MS = 60 * 60_000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const TABLE_MIME: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

interface Meta extends Omit<GhostHandoffFile, 'ref'> {
  version: 1;
  id: string;
}

export class GhostHandoffQuotaError extends Error {}

export function handoffMimeType(name: string): string {
  return TABLE_MIME[path.extname(name).toLowerCase()] ?? mediaTypeForLibraryPath(name);
}

/** Display names keep the user's file name only: no directories or control characters. */
function displayName(name: string): string {
  const base = [...(name.split(/[\\/]/).pop() ?? '')]
    .filter((char) => char.charCodeAt(0) > 0x1f && char !== '\u007f').join('').trim();
  return (base || 'file').slice(0, 255);
}

async function fsyncDir(dir: string): Promise<void> {
  // Windows cannot open directories for fsync; the rename itself stays atomic.
  const handle = await fs.open(dir, 'r').catch(() => null);
  await handle?.sync().catch(() => {});
  await handle?.close().catch(() => {});
}

function toFile(meta: Meta): GhostHandoffFile {
  const { version: _version, id, ...rest } = meta;
  void _version;
  return { ref: `handoff:${id}`, ...rest };
}

export class GhostHandoffStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly holds = new Map<string, number>();

  constructor(private readonly deps: { root(): string; now?(): number; quota?: { files: number; bytes: number } }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private instanceDir(instance: string, root = this.deps.root()): string {
    if (!INSTANCE_RE.test(instance)) throw new Error('invalid plugin instance');
    return path.join(root, instance);
  }

  /** Serialize mutations per instance so quota checks and imports cannot interleave. */
  private exclusive<T>(instance: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(instance) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const settled = run.catch(() => {});
    this.queues.set(instance, settled);
    void settled.then(() => {
      if (this.queues.get(instance) === settled) this.queues.delete(instance);
    });
    return run;
  }

  private async readMeta(dir: string, id: string): Promise<Meta | null> {
    try {
      const entry = await fs.lstat(path.join(dir, id));
      if (!entry.isDirectory()) return null;
      const handle = await fs.open(path.join(dir, id, 'meta.json'), constants.O_RDONLY | NO_FOLLOW);
      let meta: Meta;
      try {
        meta = JSON.parse(await handle.readFile('utf8')) as Meta;
      } finally {
        await handle.close();
      }
      const valid = meta?.version === 1 && meta.id === id && typeof meta.name === 'string' &&
        typeof meta.mimeType === 'string' && Number.isSafeInteger(meta.size) && meta.size >= 0 &&
        /^[a-f0-9]{64}$/.test(meta.sha256) && Number.isFinite(meta.createdAt) &&
        Number.isFinite(meta.expiresAt);
      return valid ? meta : null;
    } catch {
      return null;
    }
  }

  private async remove(dir: string, id: string): Promise<boolean> {
    // Rename first: a crash mid-delete leaves a `.tmp/del-*` entry, not half an entry.
    const doomed = path.join(dir, TMP, `del-${randomUUID()}`);
    try {
      await fs.mkdir(path.join(dir, TMP), { recursive: true, mode: 0o700 });
      await fs.rename(path.join(dir, id), doomed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    await fs.rm(doomed, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  /** Live entries, newest first; expired or unreadable entries are deleted on the way. */
  async list(instance: string): Promise<GhostHandoffFile[]> {
    return this.listDir(this.instanceDir(instance));
  }

  private async listDir(dir: string): Promise<GhostHandoffFile[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const files: GhostHandoffFile[] = [];
    for (const id of names) {
      if (!ID_RE.test(id)) continue;
      const meta = await this.readMeta(dir, id);
      if (!meta || meta.expiresAt <= this.now()) await this.remove(dir, id).catch(() => {});
      else files.push(toFile(meta));
    }
    return files.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Quota check for the confirmation gate; import re-checks inside the instance queue. */
  async assertQuota(instance: string, incoming: readonly number[], dir = this.instanceDir(instance)): Promise<void> {
    const files = await this.listDir(dir);
    const bytes = files.reduce((sum, file) => sum + file.size, 0) + incoming.reduce((sum, size) => sum + size, 0);
    const quota = this.deps.quota ?? { files: GHOST_HANDOFF_QUOTA_FILES, bytes: GHOST_HANDOFF_QUOTA_BYTES };
    if (files.length + incoming.length > quota.files || bytes > quota.bytes) {
      throw new GhostHandoffQuotaError('handoff quota exceeded');
    }
  }

  /**
   * A handoff in flight (stored, not yet delivered) holds its instance so a
   * source change waits instead of moving the copies away from the call.
   */
  hold(instance: string): () => void {
    this.holds.set(instance, (this.holds.get(instance) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(instance) ?? 1) - 1;
      if (left > 0) this.holds.set(instance, left);
      else this.holds.delete(instance);
    };
  }

  isBusy(instance: string): boolean {
    return this.holds.has(instance);
  }

  /** The owner root now; callers that clean up later keep it so an account switch cannot redirect them. */
  currentRoot(): string {
    return this.deps.root();
  }

  /** Store approved bytes as one batch: either every copy becomes visible or none stays. */
  async import(
    instance: string,
    files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
    assertCurrent: () => void,
    root = this.deps.root(),
  ): Promise<GhostHandoffFile[]> {
    const dir = this.instanceDir(instance, root);
    return this.exclusive(instance, async () => {
      await this.assertQuota(instance, files.map((file) => file.bytes.byteLength), dir);
      await fs.mkdir(path.join(dir, TMP), { recursive: true, mode: 0o700 });
      const imported: Meta[] = [];
      let staging: string | undefined;
      try {
        for (const file of files) {
          assertCurrent();
          const id = randomUUID();
          staging = path.join(dir, TMP, id);
          await fs.mkdir(staging, { mode: 0o700 });
          const createdAt = this.now();
          const name = displayName(file.name);
          const meta: Meta = {
            version: 1, id, name, mimeType: handoffMimeType(name), size: file.bytes.byteLength,
            sha256: createHash('sha256').update(file.bytes).digest('hex'),
            createdAt, expiresAt: createdAt + GHOST_HANDOFF_TTL_MS,
          };
          for (const [target, content] of [['blob', file.bytes], ['meta.json', JSON.stringify(meta)]] as const) {
            const handle = await fs.open(path.join(staging, target), 'wx', 0o600);
            try {
              await handle.writeFile(content);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          await fsyncDir(staging);
          assertCurrent();
          await fs.rename(staging, path.join(dir, id));
          staging = undefined;
          imported.push(meta);
        }
        await fsyncDir(dir);
      } catch (error) {
        // Only a crash leaves staging for the sweep; an ordinary failure cleans up now.
        if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        for (const meta of imported) await this.remove(dir, meta.id).catch(() => {});
        throw error;
      }
      return imported.map(toFile);
    });
  }

  /** Open a live copy without following links; the caller closes the handle. */
  async open(instance: string, ref: string): Promise<{ file: fs.FileHandle; info: GhostHandoffFile } | null> {
    const id = GHOST_HANDOFF_REF_RE.exec(ref)?.[1];
    if (!id) return null;
    const dir = this.instanceDir(instance);
    const meta = await this.readMeta(dir, id);
    if (!meta || meta.expiresAt <= this.now()) {
      await this.remove(dir, id).catch(() => {});
      return null;
    }
    const blob = path.join(dir, id, 'blob');
    let file: fs.FileHandle;
    try {
      file = await fs.open(blob, constants.O_RDONLY | NO_FOLLOW);
    } catch {
      return null;
    }
    try {
      const opened = await file.stat({ bigint: true });
      const current = await fs.lstat(blob, { bigint: true });
      if (!opened.isFile() || opened.size !== BigInt(meta.size) || !current.isFile() ||
          current.dev !== opened.dev || current.ino !== opened.ino) {
        await file.close();
        return null;
      }
      return { file, info: toFile(meta) };
    } catch {
      await file.close();
      return null;
    }
  }

  async delete(instance: string, ref: string, root = this.deps.root()): Promise<boolean> {
    const id = GHOST_HANDOFF_REF_RE.exec(ref)?.[1];
    if (!id) return false;
    const dir = this.instanceDir(instance, root);
    return this.exclusive(instance, () => this.remove(dir, id));
  }

  /** Uninstall: every copy of this instance goes; nothing here is user work. */
  async removeInstance(instance: string): Promise<void> {
    const dir = this.instanceDir(instance);
    await this.exclusive(instance, () => fs.rm(dir, { recursive: true, force: true }));
  }

  /** Startup / account-switch sweep: expired entries, stale staging and interrupted deletes. */
  async sweep(): Promise<void> {
    // One root for the whole sweep: an account switch must not redirect it mid-way.
    const root = this.deps.root();
    let instances: string[];
    try {
      instances = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const instance of instances) {
      if (!INSTANCE_RE.test(instance)) continue;
      const dir = this.instanceDir(instance, root);
      await this.exclusive(instance, async () => {
        const tmp = path.join(dir, TMP);
        for (const name of await fs.readdir(tmp).catch(() => [] as string[])) {
          const target = path.join(tmp, name);
          const stat = await fs.lstat(target).catch(() => null);
          if (stat && (name.startsWith('del-') || this.now() - stat.mtimeMs > STALE_TMP_MS)) {
            await fs.rm(target, { recursive: true, force: true }).catch(() => {});
          }
        }
        if ((await this.listDir(dir)).length === 0) {
          await fs.rmdir(tmp).catch(() => {});
          await fs.rmdir(dir).catch(() => {});
        }
      });
    }
  }
}
