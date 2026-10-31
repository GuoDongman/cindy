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
    fs.writeFileSync(path.join(staging, 'kept.csv'), 'partial');
    const old = new Date(now.value - 2 * 60 * 60_000);
    fs.utimesSync(staging, old, old);
    const metaless = path.join(root, 'art', '22222222-2222-4222-8222-222222222222');
    fs.mkdirSync(metaless);
    fs.writeFileSync(path.join(metaless, 'orphan.csv'), 'orphan');

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

  // Finder / Explorer show the user's file name; the name on disk must still be
  // creatable on macOS and Windows. The original name stays in the list.
  it('stores each copy under a readable portable name next to hidden metadata', async () => {
    const { root, store: s } = store({ value: Date.now() });
    const long = '季度销售数据汇总'.repeat(10) + '.xlsx';
    // Greptile 4431495701: a device name at the length limit must keep its `_` within it.
    const reservedLong = 'CON.' + 'a'.repeat(56) + '.csv';
    const names = [long, 'CON.csv', 'report..', '???.csv', 'a:b.tsv', reservedLong];
    const files = await s.import('art', names.map((name) => ({ name, bytes: bytes(name) })), () => {});
    const onDisk = files.map((file) => {
      const dir = path.join(root, 'art', file.ref.slice('handoff:'.length));
      return fs.readdirSync(dir).filter((entry) => entry !== '.cindy-handoff.json');
    });

    expect(onDisk).toEqual([
      ['季度销售数据汇总'.repeat(10).slice(0, 59) + '.xlsx'],
      ['_CON.csv'], ['report'], ['file.csv'], ['ab.tsv'], ['_CON.' + 'a'.repeat(55) + '.csv'],
    ]);
    expect(files.map((file) => file.name)).toEqual(names);
    // The stored name must validate again on the next read, or the copy is swept as damaged.
    expect((await s.list('art')).map((file) => file.name).sort()).toEqual([...names].sort());
    const opened = await s.open('art', files[0]!.ref);
    expect(await opened!.file.readFile({ encoding: 'utf8' })).toBe(long);
    await opened!.file.close();
    expect(await s.folder('art')).toBe(path.join(root, 'art'));
    expect(await s.folder('other')).toBeNull();
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
