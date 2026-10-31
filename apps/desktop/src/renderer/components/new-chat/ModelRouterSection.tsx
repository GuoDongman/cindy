/**
 * ModelRouterSection — 新任务模型选择器里的「插件 · 让插件选」(2026-10-31)。
 * ---------------------------------------------------------------------------
 * 只在新建任务的选择器出现(草稿传了 modelRouter 时)：选中后新任务第一条消息发出前问一次
 * 插件用哪个模型，之后任务不再换；记住为新任务默认，手动选任何模型即清除。
 * 行样式与模型行一致：18px 图标盒、名字 14/500、说明 12 次级色，选中整行底色不加勾。
 */
import { Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { COMPOSER_MENU_ROW, menuRowAttrs } from '@/components/ui/menu-row';
import { cn } from '@/lib/utils';

export interface ModelRouterPickerProps {
  /** 已启用、声明了「开新任务时」且用户已批准的插件。 */
  candidates: readonly { pluginId: string; name: string }[];
  /** 当前记住的插件；null = 没用插件选。 */
  activePluginId: string | null;
  onSelect(pluginId: string): void;
}

export function ModelRouterSection({ router, onPicked }: { router: ModelRouterPickerProps; onPicked(): void }) {
  const { t } = useTranslation();
  if (router.candidates.length === 0) return null;
  const label = t('newChat.modelSelector.pluginRouter.group');
  return (
    <div role="group" aria-label={label}>
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta)]">
        <span className="truncate">{label}</span>
      </div>
      {router.candidates.map((candidate) => {
        const selected = candidate.pluginId === router.activePluginId;
        const choose = () => {
          router.onSelect(candidate.pluginId);
          onPicked();
        };
        return (
          <div
            key={candidate.pluginId}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            data-model-router={candidate.pluginId}
            data-state={selected ? 'checked' : undefined}
            {...menuRowAttrs()}
            onClick={choose}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              choose();
            }}
            className={cn(
              COMPOSER_MENU_ROW,
              'group/row flex w-full cursor-pointer flex-col px-3 py-2',
              selected && 'bg-sidebar-item-hover data-[menu-active]:bg-transparent',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[var(--text-secondary)]">
                <Plug size={15} aria-hidden />
              </span>
              <span className="min-w-0 truncate font-medium leading-5">{t('newChat.modelSelector.pluginRouter.title')}</span>
            </div>
            <div
              title={t('newChat.modelSelector.pluginRouter.detail', { name: candidate.name })}
              className="min-w-0 max-w-[36ch] truncate pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)]"
            >
              {t('newChat.modelSelector.pluginRouter.detail', { name: candidate.name })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
