import type { ClipboardEvent } from 'react';

const MEDIA_SELECTOR = 'img, video, audio, canvas, iframe, object, embed';

// Chromium serializes a lone list item with its <ol>/<ul>/<li> ancestors, so rich-text targets
// (Slack, TextEdit) rebuild a number or bullet the user never selected (#7416). For exactly that
// selection return the selected content without the list wrapper; null means "use native copy".
function selectionWithoutListWrapper(selection: Selection): { text: string; html: string } | null {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startElement =
    startNode.nodeType === Node.ELEMENT_NODE ? (startNode as Element) : startNode.parentElement;
  const item = startElement?.closest('li');
  // shortcut: nested lists keep native copy (their markers are inherently part of the structure).
  if (!item || !['OL', 'UL'].includes(item.parentElement?.tagName ?? '') || item.querySelector('li')) {
    return null;
  }
  if (!item.contains(range.endContainer)) return null;
  const fragment = range.cloneContents();
  // Keep Chromium's own flavors for non-text selections (e.g. a copied image).
  if (fragment.querySelector(MEDIA_SELECTOR)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  // cloneContents() drops ancestors of a selection inside one inline element (link text only);
  // re-wrap with shallow clones up to the <li> so href and formatting survive.
  let html: Node = fragment;
  const common = range.commonAncestorContainer;
  for (
    let el = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
    el && el !== item;
    el = el.parentElement
  ) {
    const shell = el.cloneNode(false);
    shell.appendChild(html);
    html = shell;
  }
  const holder = document.createElement('div');
  holder.appendChild(html);
  return { text, html: holder.innerHTML };
}

/** The one `onCopy` for assistant message content: put clipboard fixes for assistant replies here. */
export function handleAssistantCopy(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  const picked = selection ? selectionWithoutListWrapper(selection) : null;
  if (!picked) return;
  event.clipboardData?.setData('text/plain', picked.text);
  event.clipboardData?.setData('text/html', picked.html);
  event.preventDefault();
}
