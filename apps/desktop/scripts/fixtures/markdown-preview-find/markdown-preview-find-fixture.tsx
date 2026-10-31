import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { TextLightbox } from '../../../src/renderer/components/chat/TextLightbox';
import { FindInPageBar } from '../../../src/renderer/components/find-in-page/FindInPageBar';
import { FileBodyView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';
import { WorkdirBrowseSidebar } from '../../../src/renderer/features/cc-agent/workdir-browse/WorkdirBrowseSidebar';

const markdown = [
  '# Markdown 查找验证',
  '正文中的苹果。',
  ...Array.from({ length: 25 }, (_, index) => `第 ${index + 1} 段：用于验证查找能够滚动到文档末尾。`),
  '| 内容 | 数量 |\n| --- | --- |\n| 苹果 | 2 |',
].join('\n\n');

function Fixture({ editor, projectSearch }: { editor: boolean; projectSearch: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main className="flex h-screen flex-col gap-4 p-6">
        <p>背景聊天中的苹果不应计入文档搜索。</p>
        <button data-testid="open-preview" onClick={() => setOpen(true)}>打开 Markdown 示例</button>
        {projectSearch && <div className="h-64 w-64"><WorkdirBrowseSidebar
          sessionId="fixture-session"
          workdir="/fixture"
          displayName="示例项目"
          projectKey={null}
          switchProjects={[]}
        /></div>}
        {editor && <FileBodyView
          workdir="/fixture"
          relPath="background.md"
          allowEdit={false}
          content={{ kind: 'text', relPath: 'background.md', content: '# 背景文档\n\n苹果', size: 24, mtimeMs: 0, truncated: false }}
        />}
      </main>
      <FindInPageBar />
      {open && <TextLightbox filePath="/fixture/preview.md" onClose={() => setOpen(false)} />}
    </>
  );
}

mountPage({
  route: '/',
  host: ctx => ({
    fileBrowser: {
      listDir: async () => [],
      startWatch: async () => undefined,
      stopWatch: async () => undefined,
      onEvent: subscription('file-tree'),
    },
    search: {
      onEvent: subscription('project-search'),
      start: async () => ({ ok: true, searchId: 'fixture-search', replay: [{ type: 'end', searchId: 'fixture-search', truncated: false }] }),
      cancel: async () => undefined,
    },
    readTextFilePreview: async () => {
      if (ctx.case === 'loading-editor') {
        await new Promise<void>(resolve => {
          window.addEventListener('fixture-preview-ready', () => resolve(), { once: true });
        });
      }
      return {
        success: true,
        data: ctx.case === 'nested-mermaid'
          ? markdown.replace('正文中的苹果。', '正文中的苹果。\n\n```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```')
          : markdown,
        size: markdown.length,
      };
    },
    appShortcuts: {
      getState: () => ({ platform: ctx.platform, overrides: {}, globalFailures: [] }),
      onChanged: subscription('shortcuts'),
    },
    voiceInput: { getDataSnapshot: () => ({ settings: {} }), onDataChanged: subscription('voice') },
  }),
  render: ctx => <Fixture editor={['background-editor', 'loading-editor'].includes(ctx.case)} projectSearch={ctx.case === 'background-project-search'} />,
});
