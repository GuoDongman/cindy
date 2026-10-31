/**
 * Chat files handed to a plugin are host-owned 7-day copies (`handoff:<uuid>`).
 * Rule: docs/dev-rules/plugin-security-and-authoring.md §4 (attachment handoff).
 * Gap: new store; nothing else covers expiry, crash leftovers, isolation or quota.
 * Tier: unit, real filesystem under a mkdtemp root, injected clock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GhostHandoffQuotaError, GhostHandoffStore } from '../handoffStore';
import { GHOST_HANDOFF_TTL_MS } from '../../../shared/ghost';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-handoff-store-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
let roots = 0;
function store(now: { value: number }, quota?: { files: number; bytes: number }) {
  const root = path.join(temp, `root-${++roots}`);
  return { root, store: new GhostHandoffStore({ root: () => root, now: () => now.value, quota }) };
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe('GhostHandoffStore', () => {
  // Boundary: a copy is live strictly before createdAt + 7 days and gone from then on.
  it('expires exactly at seven days and removes the copy on access', async () => {
    const now = { value: 1_000 };
    const { root, store: s } = store(now);
    const [file] = await s.import('art', [{ name: 'a.csv', bytes: bytes('a,b') }], () => {});
    expect(file).toMatchObject({ name: 'a.csv', size: 3, mimeType: 'text/csv; charset=utf-8', expiresAt: 1_000 + GHOST_HANDOFF_TTL_MS });

    now.value = file!.expiresAt - 1;
    const live = await s.open('art', file!.ref);
    expect(await live!.file.readFile({ encoding: 'utf8' })).toBe('a,b');
    await live!.file.close();

    now.value = file!.expiresAt;
    expect(await s.open('art', file!.ref)).toBeNull();
    expect(await s.list('art')).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'art')).filter((name) => name !== '.tmp')).toEqual([]);
  });

  // Crash safety: half-written staging and entries without metadata never surface.
  it('sweeps stale staging and unreadable entries but keeps complete copies', async () => {
    const now = { value: Date.now() };
    const { root, store: s } = store(now);
    const [kept] = await s.import('art', [{ name: 'kept.csv', bytes: bytes('1') }], () => {});
    const staging = path.join(root, 'art', '.tmp', '11111111-1111-4111-8111-111111111111');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'blob'), 'partial');
    const old = new Date(now.value - 2 * 60 * 60_000);
    fs.utimesSync(staging, old, old);
    const metaless = path.join(root, 'art', '22222222-2222-4222-8222-222222222222');
    fs.mkdirSync(metaless);
    fs.writeFileSync(path.join(metaless, 'blob'), 'orphan');

    await s.sweep();

    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(metaless)).toBe(false);
    expect((await s.list('art')).map((file) => file.ref)).toEqual([kept!.ref]);
  });

  // An ordinary failure mid-batch leaves neither copies nor staging behind.
  it('removes the staging directory of a batch that fails before publishing', async () => {
    const { root, store: s } = store({ value: Date.now() });
    let checks = 0;
    await expect(s.import('art', [{ name: 'a.csv', bytes: bytes('x') }], () => {
      if (++checks === 2) throw new Error('authorization changed');
    })).rejects.toThrow('authorization changed');
    expect(fs.readdirSync(path.join(root, 'art', '.tmp'))).toEqual([]);
    expect(await s.list('art')).toEqual([]);
  });

  // Isolation: a reference is meaningful only inside the instance it was handed to.
  it('does not open another instance reference', async () => {
    const { store: s } = store({ value: Date.now() });
    const [file] = await s.import('art', [{ name: 'a.csv', bytes: bytes('x') }], () => {});
    expect(await s.open('other', file!.ref)).toBeNull();
    expect(await s.delete('other', file!.ref)).toBe(false);
    expect(await s.list('art')).toHaveLength(1);
  });

  // Quota: a full instance rejects new copies instead of evicting unprocessed ones.
  it('rejects the copy that would exceed the per-instance file quota', async () => {
    const { store: s } = store({ value: Date.now() }, { files: 2, bytes: 1024 });
    await s.import('art', [{ name: '1.csv', bytes: bytes('x') }, { name: '2.csv', bytes: bytes('y') }], () => {});
    await expect(s.assertQuota('art', [1])).rejects.toBeInstanceOf(GhostHandoffQuotaError);
    await expect(s.import('art', [{ name: 'late.csv', bytes: bytes('z') }], () => {})).rejects.toBeInstanceOf(GhostHandoffQuotaError);
    expect((await s.list('art')).map((file) => file.name).sort()).toEqual(['1.csv', '2.csv']);
  });
});
