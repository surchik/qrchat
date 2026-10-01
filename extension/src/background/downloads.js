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

/** Expect the user to finish a gate in another tab; claim the next matching audio download. */
export async function registerCapture({ entryId, baseName, folder, hosts, tabId, ttlMs = 20 * 60 * 1000 }) {
  await load();
  const now = Date.now();
  state.captures = state.captures.filter((c) => c.expires > now && c.entryId !== entryId);
  state.captures.push({ entryId, baseName, folder, hosts: hosts.filter(Boolean), tabId, expires: now + ttlMs });
  await save();
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
  const now = Date.now();
  const live = state.captures.filter((c) => c.expires > now);
  if (!live.length) return null;
  if (!AUDIO_EXT.has(chooseExt(item))) return null;
  const seen = [item.referrer, item.url, item.finalUrl].map(hostOf).filter(Boolean);
  const hostHit = (c) => c.hosts.some((h) => seen.some((x) => x === h || x.endsWith(`.${h}`)));
  // Newest capture whose gate host matches; with exactly one pending gate, take any audio file.
  let cap = [...live].reverse().find(hostHit);
  if (!cap && live.length === 1) [cap] = live;
  if (!cap) return null;
  state.captures = state.captures.filter((c) => c !== cap);
  const meta = { entryId: cap.entryId, baseName: cap.baseName, folder: cap.folder, tabId: cap.tabId, captured: true };
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
