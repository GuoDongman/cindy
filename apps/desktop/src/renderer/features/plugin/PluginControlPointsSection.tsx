/**
 * PluginControlPointsSection — 插件详情页「运行前检查」(控制节点，2026-10-31)。
 * ---------------------------------------------------------------------------
 * 列出本插件声明的控制节点(自动化运行前、例行任务运行前 …)。插件只能让这次跳过或
 * 拦下，不能替用户放行；插件没有及时回应时怎么办由用户在这里按节点选择。
 * 声明了但用户还没在安装/更新确认里批准的节点显示「还没生效」。
 *
 * - 只在本机已安装插件渲染；数据走 Desktop 专用 IPC `ghosts:control-points:*`；
 * - 颜色只用语义 token，Light / Dark 由主题变量自动适配。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { GhostControlPointFailureAction, GhostControlPointSetting } from '../../../shared/ghost';

const SECTION_CLASS = 'mt-10';
const HEADING_CLASS = 'text-18 font-medium leading-[1.444] text-[var(--text-primary)]';
const SURFACE_CLASS =
  'border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]';

export function PluginControlPointsSection({ ghostId, declared }: { ghostId: string; declared: boolean }) {
  if (!declared) return null;
  return <PluginControlPointsSectionInner ghostId={ghostId} />;
}

function PluginControlPointsSectionInner({ ghostId }: { ghostId: string }) {
  const { t } = useTranslation();
  const [points, setPoints] = useState<GhostControlPointSetting[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPoints(await window.electronAPI.ghosts.getControlPoints(ghostId));
    } catch {
      setPoints([]);
    }
  }, [ghostId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (points.length === 0) return null;

  const save = async (point: GhostControlPointSetting, value: string) => {
    const action = value as GhostControlPointFailureAction;
    const previous = point.onFailure;
    setSaving(point.id);
    setPoints((list) => list.map((item) => (item.id === point.id ? { ...item, onFailure: action } : item)));
    try {
      await window.electronAPI.ghosts.setControlPointFailure(ghostId, point.id, action);
    } catch {
      setPoints((list) => list.map((item) => (item.id === point.id ? { ...item, onFailure: previous } : item)));
      toast.error(t('settings.ghosts.controlPoints.saveFailed'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className={SECTION_CLASS} aria-labelledby="ghost-control-points-title">
      <h2 id="ghost-control-points-title" className={HEADING_CLASS}>
        {t('settings.ghosts.controlPoints.title')}
      </h2>
      <p className="mt-2 max-w-[760px] text-13 leading-5 text-[var(--text-secondary)]">
        {t('settings.ghosts.controlPoints.description')}
      </p>
      <ul className="mt-5 max-w-[760px] space-y-3">
        {points.map((point) => (
          <li
            key={point.id}
            className={cn(SURFACE_CLASS, 'flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl px-5 py-4')}
          >
            <div className="min-w-[200px] flex-1">
              <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
                {t(`settings.ghosts.controlPoints.points.${point.id}`)}
              </p>
              {!point.active ? (
                <p className="mt-0.5 text-13 leading-5 text-[var(--text-secondary)]">
                  {t('settings.ghosts.controlPoints.inactive')}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <span id={`control-point-${point.id}-label`} className="text-12 leading-4 text-[var(--text-tertiary)]">
                {t('settings.ghosts.controlPoints.onFailureLabel')}
              </span>
              <Select
                label={t('settings.ghosts.controlPoints.onFailureLabel')}
                aria-describedby={`control-point-${point.id}-label`}
                value={point.onFailure}
                disabled={saving === point.id}
                className="min-h-8 min-w-[160px] text-13"
                options={point.failureActions.map((action) => ({
                  value: action,
                  label: t(`settings.ghosts.controlPoints.onFailure.${action}`),
                }))}
                onValueChange={(value) => void save(point, value)}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
