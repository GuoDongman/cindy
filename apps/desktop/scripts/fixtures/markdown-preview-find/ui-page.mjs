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
  },
  async check(page, ui) {
    const findKey = ui.platform === 'darwin' ? 'Meta+f' : 'Control+f';
    // Keep a search open behind the preview to exercise retargeting and the
    // editor capture listener that used to consume the same shortcut first.
    await page.keyboard.press(findKey);
    if (ui.case === 'background-editor') await page.locator('[data-doc-search-bar]').waitFor();
    else await page.getByRole('searchbox').waitFor();
    await page.getByTestId('open-preview').click();
    const card = page.locator('[data-text-lightbox-card]');
    const body = page.locator('[data-text-lightbox-search-root]');
    await card.getByRole('heading', { name: 'Markdown 查找验证', exact: true }).waitFor();
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
    await card.getByRole('button', { name: await ui.t('findInPage.next'), exact: true }).click();
    await card.getByText('2/2', { exact: true }).waitFor();
    assert.ok(await body.evaluate(el => el.scrollTop) > 0);
    await ui.capture('table-match');
    await input.focus();
    await page.keyboard.press('Shift+Enter');
    await card.getByText('1/2', { exact: true }).waitFor();
    await body.click({ position: { x: 20, y: 120 } });
    await page.keyboard.press('Escape');
    await input.waitFor({ state: 'detached' });
    assert.equal(await card.isVisible(), true);
    assert.equal(await page.evaluate(() => CSS.highlights.has('cindy-find-in-page-match')), false);
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
    await page.keyboard.press(findKey);
    if (ui.case === 'background-editor') await page.locator('[data-doc-search-bar] input').fill('苹果');
    else await page.getByRole('searchbox').fill('苹果');
    await page.getByText('1/1', { exact: true }).waitFor();
  },
};
