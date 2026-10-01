// Download bookkeeping: name files consistently, and attach downloads that a gate page
// (Hypeddit, Dropbox, Bandcamp free page...) starts on its own back to the hunt that opened it.

import { sanitizeSegment } from '../lib/normalize.js';
import { hostOf } from '../lib/freelinks.js';

const AUDIO_EXT = new Set(['wav', 'aif', 'aiff', 'flac', 'mp3', 'm4a', 'alac', 'ogg', 'opus', 'zip']);
const MIME_EXT = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
};

// Persisted in storage.session because the service worker can be torn down mid-download.
let state = { byUrl: {}, byId: {}, captures: [] };
let loading = null;
let finishedListener = () => {};

function load() {
  if (!loading) {
    loading = chrome.storage.session.get('dl').then(({ dl }) => {
      if (dl) state = { byUrl: {}, byId: {}, captures: [], ...dl };
    });
  }
  return loading;
}

function save() {
  return chrome.storage.session.set({ dl: state });
}

export function onDownloadFinished(fn) {
  finishedListener = fn;
}

export function extOf(name) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function buildRelativePath(folder, baseName, ext) {
  const segs = String(folder || '')
    .split('/')
    .filter((s) => s.trim())
    .map((s) => sanitizeSegment(s, 80));
  segs.push(`${sanitizeSegment(baseName, 150)}.${ext}`);
  return segs.join('/');
}

function chooseExt(item) {
  const fromName = extOf(item.filename);
  if (AUDIO_EXT.has(fromName)) return fromName;
  return MIME_EXT[(item.mime || '').toLowerCase()] || fromName || 'bin';
}

/** Start a download we initiated ourselves. Returns the Chrome download id. */
export async function startDownload({ url, baseName, folder, entryId, tabId, headers }) {
  await load();
  const meta = { entryId, baseName, folder, tabId };
  state.byUrl[url] = meta;
  await save();
  const opts = { url, conflictAction: 'uniquify', saveAs: false };
  if (headers && headers.length) opts.headers = headers;
  let id;
  try {
    id = await chrome.downloads.download(opts);
  } finally {
    delete state.byUrl[url];
  }
  if (id != null) state.byId[id] = meta;
  await save();
  return id;
}

/**
 * Expect a gate to produce a download. `gateTabIds` are the tab(s) showing the gate; tabs the
 * gate opens later (OAuth popups, Dropbox pages) are added via addGateTab().
 */
export async function registerCapture({ entryId, baseName, folder, hosts, tabId, gateTabIds = [], label = '', batchId = null, ttlMs = 30 * 60 * 1000 }) {
  await load();
  const now = Date.now();
  state.captures = state.captures.filter((c) => c.expires > now && c.entryId !== entryId);
  state.captures.push({ entryId, baseName, folder, label, batchId, hosts: hosts.filter(Boolean), tabId, gateTabIds, armedAt: 0, expires: now + ttlMs });
  await save();
}

export async function captureForTab(tabId) {
  await load();
  const now = Date.now();
  return state.captures.find((c) => c.expires > now && c.gateTabIds.includes(tabId)) || null;
}

/** A tab opened by a gate tab (popup, new tab) belongs to the same gate. */
export async function addGateTab(openerTabId, tabId) {
  const cap = await captureForTab(openerTabId);
  if (!cap || cap.gateTabIds.includes(tabId)) return false;
  cap.gateTabIds.push(tabId);
  await save();
  return true;
}

/** The gate page reports a click on a download-ish control: the next download is probably this gate's. */
export async function armCapture(tabId) {
  const cap = await captureForTab(tabId);
  if (!cap) return;
  cap.armedAt = Date.now();
  await save();
}

export async function dropCapture(entryId) {
  await load();
  state.captures = state.captures.filter((c) => c.entryId !== entryId);
  await save();
}

export async function liveCaptures() {
  await load();
  const now = Date.now();
  return state.captures.filter((c) => c.expires > now);
}

function stripHash(u) {
  return String(u || '').split('#')[0];
}

async function tabUrls(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const t = await chrome.tabs.get(id);
      if (t?.url) out.push(stripHash(t.url));
      if (t?.pendingUrl) out.push(stripHash(t.pendingUrl));
    } catch {
      // tab closed
    }
  }
  return out;
}

/**
 * Which pending gate does this download belong to? Most specific evidence first; when the
 * evidence is ambiguous we return null rather than mislabel someone else's file.
 */
async function matchCapture(item, live) {
  const referrer = stripHash(item.referrer);
  if (referrer) {
    for (const c of live) {
      if ((await tabUrls(c.gateTabIds)).includes(referrer)) return c;
    }
  }
  const now = Date.now();
  const armed = live.filter((c) => c.armedAt && now - c.armedAt < 90 * 1000).sort((a, b) => b.armedAt - a.armedAt);
  if (armed.length === 1 || (armed.length > 1 && armed[0].armedAt - armed[1].armedAt > 2000)) return armed[0];
  const seen = [item.referrer, item.url, item.finalUrl].map(hostOf).filter(Boolean);
  const hostHits = live.filter((c) => c.hosts.some((h) => seen.some((x) => x === h || x.endsWith(`.${h}`))));
  if (hostHits.length === 1) return hostHits[0];
  // No evidence linking this file to a gate: leave it alone (it's probably an unrelated download).
  return null;
}

async function metaFor(item) {
  await load();
  if (state.byId[item.id]) return state.byId[item.id];
  const direct = state.byUrl[item.url] || (item.finalUrl && state.byUrl[item.finalUrl]);
  if (direct) {
    state.byId[item.id] = direct;
    await save();
    return direct;
  }
  if (item.byExtensionId) return null;
  const now = Date.now();
  const live = state.captures.filter((c) => c.expires > now);
  if (!live.length) return null;
  if (!AUDIO_EXT.has(chooseExt(item))) return null;
  const cap = await matchCapture(item, live);
  if (!cap) return null;
  state.captures = state.captures.filter((c) => c !== cap);
  const meta = {
    entryId: cap.entryId,
    baseName: cap.baseName,
    folder: cap.folder,
    tabId: cap.tabId,
    gateTabIds: cap.gateTabIds,
    batchId: cap.batchId,
    captured: true,
  };
  state.byId[item.id] = meta;
  await save();
  return meta;
}

export function initDownloadListeners() {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    metaFor(item)
      .then((meta) => {
        if (!meta) {
          suggest();
          return;
        }
        suggest({ filename: buildRelativePath(meta.folder, meta.baseName, chooseExt(item)), conflictAction: 'uniquify' });
      })
      .catch(() => suggest());
    return true; // we call suggest asynchronously
  });

  chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state || (delta.state.current !== 'complete' && delta.state.current !== 'interrupted')) return;
    await load();
    const meta = state.byId[delta.id];
    if (!meta) return;
    delete state.byId[delta.id];
    await save();
    const [item] = await chrome.downloads.search({ id: delta.id });
    finishedListener({
      meta,
      ok: delta.state.current === 'complete',
      file: item?.filename || '',
      error: item?.error || '',
      bytes: item?.fileSize || item?.bytesReceived || 0,
    });
  });
}
