/**
 * controlPointPrefsStore —— 控制节点(will- 拦截点)的用户出错处理设置。
 *
 * File: <userData>/owners/<账号>/ghost-control-point-prefs.json
 *
 * 形态:{ onFailure: { <ghostId>: { <pointId>: 'allow' | 'skip' | 'block' } } }
 * - 插件在该节点超时、崩溃或已熔断时 Host 怎么办，由用户按插件逐节点设置；插件不能自报。
 * - 缺项 = 目录里的默认值(保持升级前行为：放行)。
 * - 只存选项，不含插件数据或凭证；抽离插件不清配置，重新装回原位沿用。
 */

import {
  GHOST_CONTROL_POINTS,
  isGhostControlPointId,
  type GhostControlPointFailureAction,
  type GhostControlPointId,
} from '../../shared/ghost.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { assertGhostPrefsWritable, relocateGhostPreferenceMaps } from './ghostPreferenceRelocation.js';

const log = desktopMakerLogger.child('control-point-prefs');

export const GHOST_CONTROL_POINT_PREFS_FILE = 'ghost-control-point-prefs.json';

export async function relocateControlPointPrefs(from: string, to: string): Promise<void> {
  await relocateGhostPreferenceMaps(GHOST_CONTROL_POINT_PREFS_FILE, ['onFailure'], from, to, () => {
    store = createStore();
  });
}

type FailurePrefs = Record<string, Partial<Record<GhostControlPointId, GhostControlPointFailureAction>>>;

interface ControlPointPrefs {
  onFailure: FailurePrefs;
}

function normalize(raw: unknown): ControlPointPrefs {
  const onFailure: FailurePrefs = {};
  const source = raw && typeof raw === 'object' ? (raw as { onFailure?: unknown }).onFailure : undefined;
  if (!source || typeof source !== 'object') return { onFailure };
  for (const [ghostId, pointsRaw] of Object.entries(source as Record<string, unknown>)) {
    if (!pointsRaw || typeof pointsRaw !== 'object') continue;
    const points: FailurePrefs[string] = {};
    for (const [point, action] of Object.entries(pointsRaw as Record<string, unknown>)) {
      // 未知节点或该节点不支持的选项按缺项处理(回到默认),不判损坏。
      if (!isGhostControlPointId(point)) continue;
      const allowed = GHOST_CONTROL_POINTS[point].failureActions as readonly string[];
      if (typeof action === 'string' && allowed.includes(action)) points[point] = action as GhostControlPointFailureAction;
    }
    if (Object.keys(points).length > 0) onFailure[ghostId] = points;
  }
  return { onFailure };
}

function createStore() {
  return createOverrideSettingsFile<ControlPointPrefs>({
    filePath: () => ownerScopedUserDataPath(GHOST_CONTROL_POINT_PREFS_FILE),
    defaults: { onFailure: {} },
    normalize,
    log,
    label: 'ghost-control-point-prefs',
    preserveUnreadableFile: true,
  });
}

let store = createStore();

/** 某插件在某节点出错时的处理；未设置返回目录默认值。 */
export function readControlPointFailureAction(
  ghostId: string,
  point: GhostControlPointId,
): GhostControlPointFailureAction {
  store.invalidateIfChanged();
  return store.read().onFailure[ghostId]?.[point] ?? GHOST_CONTROL_POINTS[point].defaultOnFailure;
}

/** 写/清某插件某节点的出错处理；null 恢复默认。 */
export function writeControlPointFailureAction(
  ghostId: string,
  point: GhostControlPointId,
  action: GhostControlPointFailureAction | null,
): void {
  assertGhostPrefsWritable(GHOST_CONTROL_POINT_PREFS_FILE);
  if (action !== null && !(GHOST_CONTROL_POINTS[point].failureActions as readonly string[]).includes(action)) {
    throw new Error(`control point ${point} does not support onFailure=${String(action)}`);
  }
  store.invalidateIfChanged();
  const onFailure = { ...store.read().onFailure };
  const points = { ...(onFailure[ghostId] ?? {}) };
  if (action === null) delete points[point];
  else points[point] = action;
  if (Object.keys(points).length > 0) onFailure[ghostId] = points;
  else delete onFailure[ghostId];
  store.writePatch({ onFailure });
  log.info('control point failure action written', { ghostId, point, action });
}

export const __testing = {
  normalize,
  resetStore: () => {
    store = createStore();
  },
};
