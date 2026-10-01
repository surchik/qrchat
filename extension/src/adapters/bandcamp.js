// Bandcamp: search, read the track's embedded data, then either open its free/NYP
// download flow or put the track in your cart.

import { parseHtml } from '../background/parse.js';
import { throttle } from '../background/ratelimit.js';

export async function searchBandcamp(query) {
  const q = [query.artist, query.title].filter(Boolean).join(' ');
  await throttle('bandcamp', 1500);
  const res = await fetch(`https://bandcamp.com/search?q=${encodeURIComponent(q)}&item_type=t`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Bandcamp search HTTP ${res.status}`);
  return parseHtml('bandcamp-search', await res.text());
}

/**
 * @returns {Promise<{free:boolean, freePage:string, minPrice:number|null, currency:string,
 *   durationSec:number|null, purchasable:boolean}>}
 */
export async function inspectTrack(url) {
  await throttle('bandcamp', 1500);
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Bandcamp page HTTP ${res.status}`);
  const t = await parseHtml('bandcamp-tralbum', await res.text());
  if (!t) return { free: false, freePage: '', minPrice: null, currency: '', durationSec: null, purchasable: false };
  const min = t.current?.minimum_price;
  const minPrice = typeof min === 'number' ? min : null;
  const freePage = t.freeDownloadPage || '';
  return {
    free: !!freePage || minPrice === 0,
    freePage,
    minPrice,
    currency: t.currency || '',
    durationSec: t.trackinfo?.[0]?.duration ? Math.round(t.trackinfo[0].duration) : null,
    purchasable: minPrice != null || !!freePage,
  };
}

// Serialized into the Bandcamp tab. Finds buttons by visible text first (stable across
// redesigns), then by the long-standing class names.
async function addToCartInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const clickables = () => Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'));
  const byText = (re) => clickables().find((el) => visible(el) && re.test((el.textContent || el.value || '').trim()));

  const buy = byText(/buy\s+(digital\s+)?(track|album)/i) || document.querySelector('.buyItem .buy-link, .download-link.buy-link');
  if (!buy) return { ok: false, reason: 'Could not find the "Buy Digital Track" button' };
  buy.click();

  let add = null;
  for (let i = 0; i < 40 && !add; i += 1) {
    await sleep(250);
    add = byText(/^add\s+to\s+cart$/i) || byText(/add\s+to\s+cart/i);
  }
  if (!add) return { ok: false, reason: 'Could not find "Add to cart" in the purchase dialog' };
  add.click();

  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    const cart = document.querySelector('#sidecart, #sidecartReveal, .sidecart, [class*="sidecart"], [data-cart-count]');
    if (visible(cart)) return { ok: true };
  }
  return { ok: true, unverified: true };
}

function waitForComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      reject(new Error('Timed out loading Bandcamp'));
    }, timeoutMs);
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') onUpd(tabId, { status: 'complete' });
    }, () => {});
  });
}

/** Add a track to the Bandcamp cart in a background tab. On failure the tab is shown to you. */
export async function addToCart(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForComplete(tab.id);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: addToCartInPage });
    const out = res?.result || { ok: false, reason: 'Script did not run' };
    if (out.ok) {
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 1500);
    } else {
      await chrome.tabs.update(tab.id, { active: true });
    }
    return out;
  } catch (e) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    return { ok: false, reason: e.message };
  }
}
