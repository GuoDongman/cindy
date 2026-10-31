import assert from 'node:assert/strict';

export default {
  name: 'markdown-preview-find',
  entry: './markdown-preview-find-fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'TextLightbox, MarkdownRenderer, FindInPageBar, FileBodyView and shortcut ownership',
  notCovered: 'Installed release, native menus, PDF/draw.io viewing and IPC file loading; benign file data is supplied by the fixture',
  stubs: {
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview':
      'export function PdfPreview() { throw new Error("PDF is outside this Markdown fixture"); }',
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview':
      'export function DrawioPreview() { throw new Error("draw.io is outside this Markdown fixture"); }',
  },
  cases: {
    default: { about: 'Document-only matching, visible pointer targets, table navigation and Escape order' },
    'background-editor': { about: 'An existing file-editor search yields shortcuts to the foreground preview' },
    'nested-mermaid': { about: 'A diagram opened from the document owns shortcuts until it closes' },
    'loading-editor': { about: 'The foreground document owns find and Escape before its file read completes' },
    'focus-restore': { about: 'Closing find restores the document toolbar opener for keyboard navigation' },
    'ime-escape': { about: 'An IME-cancelling Escape and its repeats keep search open until a new press' },
  },
  async check(page, ui) {
    const findKey = ui.platform === 'darwin' ? 'Meta+f' : 'Control+f';
    // Keep a search open behind the preview to exercise retargeting and the
    // editor capture listener that used to consume the same shortcut first.
    const editor = ['background-editor', 'loading-editor'].includes(ui.case);
    if (ui.case !== 'focus-restore') {
      await page.keyboard.press(findKey);
      if (editor) await page.locator('[data-doc-search-bar]').waitFor();
      else await page.getByRole('searchbox').waitFor();
    }
    await page.getByTestId('open-preview').click();
    const card = page.locator('[data-text-lightbox-card]');
    const body = page.locator('[data-text-lightbox-search-root]');
    await card.waitFor();
    if (ui.case === 'loading-editor') {
      await page.keyboard.press(findKey);
      const loadingInput = card.getByRole('searchbox');
      await loadingInput.waitFor();
      await loadingInput.fill('苹果');
      await card.getByText('0/0', { exact: true }).waitFor();
      await ui.capture('loading-search');
      await page.keyboard.press('Escape');
      await loadingInput.waitFor({ state: 'detached' });
      assert.equal(await card.isVisible(), true);
      await page.keyboard.press(findKey);
      await loadingInput.fill('苹果');
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-preview-ready')));
      await card.getByText('1/2', { exact: true }).waitFor();
    }
    await card.getByRole('heading', { name: 'Markdown 查找验证', exact: true }).waitFor();
    const opener = card.getByRole('button', { name: await ui.t('chat.textLightbox.copyAll'), exact: true });
    if (ui.case === 'focus-restore') await opener.focus();
    await page.keyboard.press(findKey);
    await ui.capture('preview-find-opened');
    await body.waitFor();
    const input = card.getByRole('searchbox');
    await input.click(); // Actual hit-testing catches the original z-index defect.
    await input.fill('苹果');
    await card.getByText('1/2', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => {
      const root = document.querySelector('[data-text-lightbox-search-root]');
      return [...CSS.highlights.get('cindy-find-in-page-match')].every(range => root.contains(range.startContainer));
    }), true);
    await ui.capture('document-search');
    if (ui.case === 'ime-escape') {
      // Chromium composition/key event sequence, not a native IME candidate UI.
      await input.dispatchEvent('compositionstart');
      await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
      await input.dispatchEvent('compositionend');
      await input.dispatchEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true });
      assert.equal(await input.isVisible(), true);
      await input.dispatchEvent('keyup', { key: 'Escape', bubbles: true });
      await card.getByText('1/2', { exact: true }).waitFor();
      await ui.capture('ime-cancel-keeps-search');
    }
    if (ui.case === 'nested-mermaid') {
      const diagramTrigger = card.getByRole('button', { name: await ui.t('chat.mermaid.clickToZoom'), exact: true });
      await diagramTrigger.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await input.isVisible(), true);
      await page.locator('[data-text-lightbox-overlay]').evaluate(async el => {
        await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
      });
      assert.equal(await page.locator('[data-text-lightbox-overlay]').evaluate(el => getComputedStyle(el).opacity), '1');
      await diagramTrigger.click();
      const diagram = page.locator('[data-mermaid-lightbox-overlay]');
      await diagram.waitFor();
      await page.keyboard.press(findKey);
      await ui.capture('diagram-foreground');
      assert.equal(await card.getByRole('searchbox').count(), 0);
      await page.keyboard.press('Escape');
      await diagram.waitFor({ state: 'detached' });
      assert.equal(await card.isVisible(), true);
      await page.keyboard.press(findKey);
      await input.fill('苹果');
      await card.getByText('1/2', { exact: true }).waitFor();
    }
    await card.getByRole('button', { name: await ui.t('findInPage.next'), exact: true }).click();
    await card.getByText('2/2', { exact: true }).waitFor();
    assert.ok(await body.evaluate(el => el.scrollTop) > 0);
    await ui.capture('table-match');
    await input.focus();
    await page.keyboard.press('Shift+Enter');
    await card.getByText('1/2', { exact: true }).waitFor();
    await body.click({ position: { x: 20, y: 120 } });
    await page.keyboard.down('Escape');
    await input.waitFor({ state: 'detached' });
    await page.keyboard.down('Escape'); // Repeated keydown from the same physical press.
    await page.keyboard.up('Escape');
    await page.locator('[data-text-lightbox-overlay]').evaluate(async el => {
      await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    assert.equal(await page.locator('[data-text-lightbox-overlay]').evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(await card.isVisible(), true);
    assert.equal(await page.evaluate(() => CSS.highlights.has('cindy-find-in-page-match')), false);
    if (ui.case === 'focus-restore') {
      assert.equal(await opener.evaluate(el => document.activeElement === el), true);
    }
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
    await page.keyboard.press(findKey);
    if (editor) await page.locator('[data-doc-search-bar] input').fill('苹果');
    else await page.getByRole('searchbox').fill('苹果');
    await page.getByText('1/1', { exact: true }).waitFor();
  },
};
