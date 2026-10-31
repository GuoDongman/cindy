import assert from 'node:assert/strict';

// Regression: the production MessageStream used to leave navigation highlights
// on forever. Existing scroll tests only cover landing/cancellation, not painted
// lifetime. One click is the minimal failing input; this is a real-renderer check.
export default {
  name: 'message-focus',
  entry: './focus-fixture.tsx',
  viewport: { width: 900, height: 600 },
  stubs: {
    'src/renderer/components/chat/GhostToolCard':
      'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
  },
  real: 'MessageStream navigation, focus lifecycle, background/ring transitions, theme tokens',
  notCovered: 'Host search transport, native mobile, agent execution',
  cases: {
    default: { about: 'Ordinary task message navigation' },
    compact: { about: 'Companion message navigation' },
  },
  async check(page, ui) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const target = (id) => page.locator(`[data-message-client-id="${id}"]`);
    const highlighted = (id) =>
      target(id).evaluate((node) => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)');
    const locate = async (id) => {
      await page.getByTestId(`focus-${id}`).click();
      await page.waitForFunction((id) => {
        const node = document.querySelector(`[data-message-client-id="${id}"]`);
        return node && getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)';
      }, id);
    };
    await locate('first');
    await ui.capture('highlight');
    // Sample actual browser paint through the timeout and CSS transition. A
    // content update during the lifetime must not cancel or restart expiry.
    await page.getByTestId('update').click();
    const paints = await target('first').evaluate(
      (node) =>
        new Promise((resolve) => {
          const started = performance.now();
          const values = new Set();
          const sample = () => {
            values.add(getComputedStyle(node).backgroundColor);
            if (performance.now() - started < 1700) requestAnimationFrame(sample);
            else resolve([...values]);
          };
          sample();
        }),
    );
    assert.equal(
      await highlighted('first'),
      false,
      'Navigation highlight expires despite content updates',
    );
    assert.ok(paints.length > 2, 'Highlight fades through intermediate paint values');
    await ui.capture('faded');
    await locate('first'); // Repeat the same target after its previous expiry.
    await locate('second'); // Replace a still-visible target.
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-message-client-id="first"]'))
          .backgroundColor === 'rgba(0, 0, 0, 0)',
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-message-client-id="second"]'))
          .backgroundColor === 'rgba(0, 0, 0, 0)',
    );
    await locate('second');
    await page.getByTestId('clear').click();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-message-client-id="second"]'))
          .backgroundColor === 'rgba(0, 0, 0, 0)',
    );
  },
};
