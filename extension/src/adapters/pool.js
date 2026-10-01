// Config-driven record pool adapter (used for DJDelivery). Everything site-specific lives
// in settings (search URL, selectors or JSON paths, download resolution), so the adapter can
// be pointed at the real site without code changes once its structure is known.

import { extractRows } from '../lib/extract.js';
import { mapJsonItems, getPath, fillTemplate, asText } from '../lib/jsonpath.js';
import { renderTemplate } from '../lib/normalize.js';
import { parseHtml } from '../background/parse.js';
import { throttle } from '../background/ratelimit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function originOf(cfg) {
  return new URL(cfg.baseUrl).origin;
}

/** Search strings to try, in order, e.g. "Artist Title" then just "Title". */
export function buildQueries(cfg, query) {
  // {artist} is the full credit ("Chase & Status", "Above & Beyond"); {mainartist} the first name.
  const vars = {
    artist: query.artist,
    mainartist: (query.artist || '').split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?)\s*/i)[0],
    fullartist: query.artist,
    title: query.title,
    mix: query.mix,
  };
  const out = [];
  for (const tpl of cfg.queryTemplates?.length ? cfg.queryTemplates : ['{artist} {title}']) {
    const q = renderTemplate(tpl, vars);
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}

function looksLikeLogin(cfg, res) {
  if (res.status === 401 || res.status === 403) return true;
  return !!(cfg.loginUrlIncludes && res.url && res.url.includes(cfg.loginUrlIncludes) && !cfg.searchUrl.includes(cfg.loginUrlIncludes));
}

// ---- transports -----------------------------------------------------------------------

async function bgFetch(url, { method = 'GET' } = {}) {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
  });
  return { status: res.status, url: res.url, text: await res.text() };
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpd);
      reject(new Error('Timed out loading pool page'));
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

/** Run `fn(tabId)` in an existing tab of the pool, or a temporary background tab. */
async function withPoolTab(cfg, fn, { fresh = false, url } = {}) {
  const origin = originOf(cfg);
  if (!fresh) {
    const [existing] = await chrome.tabs.query({ url: `${origin}/*` });
    if (existing && existing.status === 'complete') return fn(existing.id);
  }
  const tab = await chrome.tabs.create({ url: url || cfg.baseUrl, active: false });
  try {
    await waitForTabComplete(tab.id);
    return await fn(tab.id);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Serialized into the pool tab (MAIN world) so requests carry the site's own auth.
async function pageFetch(url, auth, method) {
  const headers = { Accept: 'application/json, text/html;q=0.9, */*;q=0.8' };
  let token = '';
  if (auth && auth.localStorageKey) {
    let v = localStorage.getItem(auth.localStorageKey);
    if (v && auth.jsonPath) {
      try {
        v = auth.jsonPath.split('.').reduce((o, k) => (o == null ? o : o[k]), JSON.parse(v));
      } catch (e) {
        v = null;
      }
    }
    if (v) {
      token = String(v);
      headers[auth.header || 'Authorization'] = `${auth.prefix == null ? 'Bearer ' : auth.prefix}${token}`;
    }
  }
  const r = await fetch(url, { method: method || 'GET', credentials: 'include', headers });
  return { status: r.status, url: r.url, text: await r.text(), token };
}

async function tabFetch(cfg, url, { method = 'GET' } = {}) {
  return withPoolTab(cfg, async (tabId) => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pageFetch,
      args: [url, cfg.auth, method],
    });
    if (!res?.result) throw new Error('Pool tab fetch failed');
    return res.result;
  });
}

async function tabRender(cfg, url) {
  return withPoolTab(cfg, async (tabId) => {
    // Rendered SPAs fill results after load; poll for rows for up to ~12s.
    for (let i = 0; i < 24; i += 1) {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractRows,
        args: [null, { ...cfg.html, loginSelector: cfg.loginSelector }, cfg.baseUrl],
      });
      const out = res?.result;
      const tab = await chrome.tabs.get(tabId);
      if (out?.items.length) return { ...out, url: tab.url, status: 200 };
      // Only trust the login selector once the page has had time to render its results.
      if (out?.loginDetected && i >= 12) return { ...out, url: tab.url, status: 200 };
      if (looksLikeLogin(cfg, { url: tab.url })) return { items: [], loginDetected: true, url: tab.url, status: 200 };
      await sleep(500);
    }
    return { items: [], loginDetected: false, status: 200, url };
  }, { fresh: true, url });
}

// ---- search -------------------------------------------------------------------------

async function runSearch(cfg, url) {
  if (cfg.transport === 'tab-render') {
    const out = await tabRender(cfg, url);
    if (out.loginDetected) return { status: 'login' };
    return { status: 'ok', items: out.items };
  }
  const res = cfg.transport === 'tab-fetch' ? await tabFetch(cfg, url) : await bgFetch(url);
  if (looksLikeLogin(cfg, res)) return { status: 'login' };
  if (res.status >= 400) return { status: 'error', message: `HTTP ${res.status}` };
  if (cfg.format === 'json') {
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      // A JSON endpoint answering with HTML almost always means a login page.
      return /<form|password/i.test(res.text) ? { status: 'login' } : { status: 'error', message: 'Response was not JSON' };
    }
    return { status: 'ok', items: mapJsonItems(json, cfg.json, cfg.baseUrl) };
  }
  const out = await parseHtml('pool-rows', res.text, { cfg: { ...cfg.html, loginSelector: cfg.loginSelector }, baseUrl: res.url || cfg.baseUrl });
  if (out.error) return { status: 'error', message: out.error };
  // A password field alone is weak evidence (logged-in pages often carry a hidden login modal):
  // report it, but let the caller try its other queries first.
  if (out.loginDetected && !out.items.length) return { status: 'login', weak: true };
  return { status: 'ok', items: out.items };
}

/**
 * @returns {Promise<{status:'ok'|'login'|'unconfigured'|'error', items?:object[], usedQuery?:string, message?:string}>}
 */
export async function searchPool(cfg, query) {
  if (!cfg.searchUrl) return { status: 'unconfigured' };
  const host = new URL(cfg.baseUrl).host;
  let weakLogin = null;
  for (const q of buildQueries(cfg, query)) {
    const url = cfg.searchUrl.replace(/\{query\}/g, encodeURIComponent(q));
    await throttle(`pool:${host}`, cfg.minIntervalMs || 3000);
    const r = await runSearch(cfg, url);
    if (r.status === 'login' && r.weak) {
      weakLogin = r;
      continue;
    }
    if (r.status !== 'ok') return r;
    if (r.items.length) return { ...r, usedQuery: q };
  }
  return weakLogin || { status: 'ok', items: [] };
}

/** Turn a result row into a downloadable URL (+ headers when the pool needs a bearer token). */
export async function resolvePoolDownload(cfg, item) {
  const d = cfg.download || {};
  let url = item.downloadUrl || (d.urlTemplate ? fillTemplate(d.urlTemplate, item) : '');
  if (!url) throw new Error('This result has no download link (check the download selector / URL template)');
  url = new URL(url, cfg.baseUrl).href;
  let token = '';
  if (d.resolveJsonPath) {
    const res = cfg.transport === 'background' ? await bgFetch(url, { method: d.method }) : await tabFetch(cfg, url, { method: d.method });
    if (looksLikeLogin(cfg, res)) throw new Error('DJDelivery session expired. Log in and retry.');
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new Error('Download endpoint did not return JSON');
    }
    const resolved = asText(getPath(json, d.resolveJsonPath));
    if (!resolved) throw new Error(`No "${d.resolveJsonPath}" in download response`);
    url = new URL(resolved, cfg.baseUrl).href;
    token = res.token || '';
  } else if (cfg.transport === 'tab-fetch' && cfg.auth?.localStorageKey) {
    const res = await tabFetch(cfg, cfg.baseUrl, { method: 'HEAD' }).catch(() => ({}));
    token = res.token || '';
  }
  const headers = [];
  // Only send the bearer token to the pool's own origin, never to a CDN/S3 redirect target.
  if (token && new URL(url).origin === originOf(cfg)) {
    headers.push({ name: cfg.auth.header || 'Authorization', value: `${cfg.auth.prefix ?? 'Bearer '}${token}` });
  }
  return { url, headers };
}
