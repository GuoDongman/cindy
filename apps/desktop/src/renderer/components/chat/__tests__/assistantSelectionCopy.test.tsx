// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'copy-test' } }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);

import { handleAssistantCopy } from '@/lib/assistantSelectionCopy';
import { MarkdownRenderer } from '../MarkdownRenderer';

// Production entry: AssistantMessage puts handleAssistantCopy on its wrapper, so copy events from the
// rendered Markdown bubble up to it. Issue #7416:
// copying one numbered item put the <ol><li> wrapper into text/html, so Slack/TextEdit rebuilt an
// unselected number. PR #7785 review: link-only selections lost the <a>, and the rewrite must not
// leak into other MarkdownRenderer callers (it lives on the assistant wrapper, not the renderer). Unit/DOM tier. jsdom's Selection.toString() is
// textContent-like (unlike Chromium), so hard-break plain text stays a manual check.
const LIST = '1. alpha\n2. beta [link](https://example.com)\n3. gamma';

type Pick = (root: HTMLElement) => [Node, number, Node, number];

function copy(pick: Pick, clean = true) {
  const { container } = render(
    <div data-testid="wrapper" onCopy={clean ? handleAssistantCopy : undefined}>
      <MarkdownRenderer workingDir="/w" content={LIST} />
    </div>,
  );
  const [startNode, startOffset, endNode, endOffset] = pick(container);
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const setData = vi.fn();
  const notPrevented = fireEvent.copy(container.querySelector('.msg-markdown')!, { clipboardData: { setData } });
  const html = setData.mock.calls.find(([type]) => type === 'text/html')?.[1] as string | undefined;
  return { prevented: !notPrevented, setData, html };
}

const items = (root: HTMLElement) => root.querySelectorAll('li');
const wholeItem2: Pick = (root) => {
  const li = items(root)[1];
  const linkText = li.querySelector('a')!.firstChild!;
  return [li.firstChild!, 0, linkText, linkText.textContent!.length];
};

describe('assistant message copy', () => {
  it('writes the item without the list wrapper (#7416)', () => {
    const { prevented, setData, html } = copy(wholeItem2);
    expect(prevented).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', 'beta link');
    expect(html).not.toMatch(/<\/?(ol|li)\b/);
  });

  it('keeps the link when only its text is selected', () => {
    const { html } = copy((root) => {
      const linkText = items(root)[1].querySelector('a')!.firstChild!;
      return [linkText, 0, linkText, 4];
    });
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.com"[^>]*>link<\/a>/);
  });

  it.each<[string, Pick, boolean]>([
    ['multi-item selection', (root) => [items(root)[0].firstChild!, 0, items(root)[2].firstChild!, 5], true],
    ['content outside an assistant message', wholeItem2, false],
  ])('leaves %s to native copy', (_name, pick, clean) => {
    const { prevented, setData } = copy(pick, clean);
    expect(prevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });
});
