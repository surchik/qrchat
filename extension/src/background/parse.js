// Service workers have no DOMParser; HTML parsing happens in an offscreen document.

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({ url: OFFSCREEN_PATH, reasons: ['DOM_PARSER'], justification: 'Parse record pool and store search pages' })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/**
 * @param {'pool-rows'|'bandcamp-search'|'bandcamp-tralbum'} op
 */
export async function parseHtml(op, html, args = {}) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', op, html, ...args });
  if (!res) throw new Error('HTML parser did not respond');
  if (res.error) throw new Error(res.error);
  return res.result;
}
