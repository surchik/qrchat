// The hunt: SoundCloud track -> query -> sources in priority order -> act on the first
// confident match (download / open gate / add to cart) -> otherwise offer review or wantlist.

import * as sc from '../adapters/soundcloud.js';
import { searchPool, resolvePoolDownload } from '../adapters/pool.js';
import { searchBandcamp, inspectTrack, addToCart } from '../adapters/bandcamp.js';
import { findTrackLinks, isActionableFreeLink, hostOf } from '../lib/freelinks.js';
import { scoreCandidate, orderByVersionPreference } from '../lib/match.js';
import { displayName, renderTemplate, canonicalScUrl } from '../lib/normalize.js';
import { getSettings, SOURCE_META, poolConfigured } from '../lib/settings.js';
import * as store from '../lib/store.js';
import { startDownload, registerCapture, onDownloadFinished } from './downloads.js';
import { takeDailyQuota } from './ratelimit.js';

const STATUS_TO_STATE = {
  searching: 'busy',
  downloading: 'busy',
  downloaded: 'done',
  gate: 'gate',
  cart: 'cart',
  link: 'link',
  review: 'review',
  want: 'want',
  error: 'error',
  failed: 'error',
  owned: 'done',
};

// ---- messaging --------------------------------------------------------------------------

function sendToTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'hunt-progress', ...msg }).catch(() => {});
}

function emit(ctx, patch) {
  sendToTab(ctx.tabId, {
    entryId: ctx.entry.id,
    scUrl: ctx.scUrl,
    label: ctx.label || ctx.scUrl,
    notes: ctx.notes.slice(-6),
    silent: !!ctx.quiet,
    ...patch,
  });
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message }).catch(() => {});
}

// ---- helpers ------------------------------------------------------------------------------

function slimQuery(q) {
  const { artist, title, mix, remixers, featuring, isrc, durationSec, genre, label } = q;
  return { artist, title, mix, remixers, featuring, isrc, durationSec, genre, label };
}

function namesFor(ctx, c) {
  const q = ctx.query;
  // Pools usually carry cleaner metadata than a SoundCloud title, so prefer it for files.
  const usePool = c && c.source === 'djdelivery' && c.artist && c.title;
  const vars = {
    artist: usePool ? c.artist : q.artist,
    title: usePool ? c.title : q.title,
    mix: usePool ? c.version || q.mix : q.mix,
    label: q.label,
    genre: q.genre,
  };
  const now = new Date();
  return {
    baseName: renderTemplate(ctx.settings.files.filename, vars) || displayName(q),
    folder: renderTemplate(ctx.settings.files.folder, {
      source: SOURCE_META[c?.source]?.label || 'Other',
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      genre: q.genre,
    }),
  };
}

let cidCounter = 0;
function candidate(source, kind, fields) {
  cidCounter += 1;
  return {
    cid: `${Date.now().toString(36)}-${cidCounter}`,
    source,
    sourceLabel: SOURCE_META[source]?.label || source,
    kind,
    score: 0,
    artist: '',
    title: '',
    version: '',
    url: '',
    detail: '',
    payload: {},
    ...fields,
  };
}

function poolItemPayload(it) {
  const { raw, ...rest } = it;
  let rawSmall;
  try {
    rawSmall = raw && JSON.stringify(raw).length < 4000 ? raw : undefined;
  } catch {
    rawSmall = undefined;
  }
  return { item: { ...rest, raw: rawSmall } };
}

async function ensureTrack(ctx) {
  if (!ctx.track) ctx.track = await sc.resolve(ctx.scUrl);
  return ctx.track;
}

// ---- sources ------------------------------------------------------------------------------

const FINDERS = {
  async djdelivery(ctx) {
    const cfg = ctx.settings.djdelivery;
    if (!poolConfigured(cfg)) return { status: 'unconfigured', note: 'not set up yet. Open Settings → DJDelivery.' };
    const r = await searchPool(cfg, ctx.query);
    if (r.status !== 'ok') return r;
    const scored = r.items.map((it) => ({ ...it, ...scoreCandidate(ctx.query, it) }));
    const ordered = orderByVersionPreference(scored, { prefer: cfg.versionPrefer, avoid: cfg.versionAvoid }, ctx.query.mix);
    return {
      status: 'ok',
      candidates: ordered.map((it) => candidate('djdelivery', 'download', {
        score: it.score,
        artist: it.artist,
        title: it.title,
        version: it.version,
        detail: [it.bpm && `${it.bpm} BPM`, it.key, it.genre].filter(Boolean).join(' · '),
        payload: poolItemPayload(it),
      })),
    };
  },

  async 'sc-original'(ctx) {
    const t = await ensureTrack(ctx);
    if (!t.downloadable) return { status: 'ok', candidates: [] };
    if (t.has_downloads_left === false) return { status: 'ok', candidates: [], note: 'the artist’s download limit is used up' };
    return {
      status: 'ok',
      candidates: [candidate('sc-original', 'download', {
        score: 1,
        artist: ctx.query.artist,
        title: ctx.query.title,
        version: ctx.query.mix,
        url: t.permalink_url,
        detail: 'Original file uploaded by the artist',
        payload: { trackId: t.id },
      })],
    };
  },

  async 'sc-links'(ctx) {
    const t = await ensureTrack(ctx);
    const out = [];
    for (const l of findTrackLinks(t, ctx.settings.freeDomains)) {
      const base = { artist: ctx.query.artist, title: ctx.query.title, version: ctx.query.mix, url: l.url };
      if (l.kind === 'bandcamp') out.push(candidate('sc-links', 'bandcamp-page', { ...base, score: 1, detail: `Bandcamp link in ${l.from === 'purchase_url' ? 'buy link' : 'description'}` }));
      else if (isActionableFreeLink(l)) out.push(candidate('sc-links', 'gate', { ...base, score: l.kind === 'gate' || l.labelledFree ? 1 : 0.9, detail: `${l.host} (${l.from === 'purchase_url' ? 'buy link' : 'description'})` }));
      else if (l.kind === 'paidstore') out.push(candidate('sc-links', 'link', { ...base, score: 0.6, detail: `Sold on ${l.host}` }));
    }
    out.sort((a, b) => b.score - a.score);
    return { status: 'ok', candidates: out };
  },

  async 'sc-alt'(ctx) {
    const q = [ctx.query.artist, ctx.query.title].filter(Boolean).join(' ');
    const results = await sc.searchTracks(q, 20);
    const selfId = ctx.track?.id;
    const out = [];
    for (const t of results) {
      if (t.id === selfId) continue;
      const p = sc.toQuery(t);
      const s = scoreCandidate(ctx.query, { artist: p.artist, title: p.title, version: p.mix, durationSec: p.durationSec });
      const base = { artist: p.artist, title: p.title, version: p.mix };
      if (t.downloadable && t.has_downloads_left !== false) {
        out.push(candidate('sc-alt', 'download', { ...base, score: s.score, url: t.permalink_url, detail: `Download enabled on ${t.user?.username || 'another'}’s upload`, payload: { trackId: t.id } }));
      }
      const link = findTrackLinks(t, ctx.settings.freeDomains).find(isActionableFreeLink);
      if (link) {
        out.push(candidate('sc-alt', link.kind === 'bandcamp' ? 'bandcamp-page' : 'gate', { ...base, score: Math.round(s.score * 0.98 * 1000) / 1000, url: link.url, detail: `${link.host} via ${t.user?.username || 'another upload'}` }));
      }
    }
    out.sort((a, b) => b.score - a.score);
    return { status: 'ok', candidates: out };
  },

  async bandcamp(ctx) {
    const results = await searchBandcamp(ctx.query);
    const scored = results
      .map((r) => ({ ...r, ...scoreCandidate(ctx.query, { artist: r.artist, title: r.title }) }))
      .sort((a, b) => b.score - a.score);
    const out = [];
    for (const r of scored.slice(0, 2)) {
      if (r.score < ctx.settings.matching.reviewThreshold) break;
      const info = await inspectTrack(r.url);
      const kind = info.free ? 'free-page' : info.purchasable ? 'cart' : 'link';
      out.push(candidate('bandcamp', kind, {
        score: r.score,
        artist: r.artist,
        title: r.title,
        url: info.free && info.freePage ? info.freePage : r.url,
        detail: info.free ? 'Free / name your price' : info.minPrice != null ? `Paid, from ${info.minPrice.toFixed(2)} ${info.currency}`.trim() : 'Not for sale',
        payload: { pageUrl: r.url },
      }));
    }
    return { status: 'ok', candidates: out };
  },
};

// ---- actions ------------------------------------------------------------------------------

async function performAction(ctx, c) {
  const { baseName, folder } = namesFor(ctx, c);
  const filehosts = ctx.settings.freeDomains.filehost || [];
  switch (c.kind) {
    case 'download': {
      let url;
      let headers = [];
      if (c.source === 'djdelivery') {
        const cfg = ctx.settings.djdelivery;
        await takeDailyQuota('djdelivery', cfg.dailyDownloadCap);
        ({ url, headers } = await resolvePoolDownload(cfg, c.payload.item));
      } else {
        url = await sc.originalDownloadUrl({ id: c.payload.trackId });
      }
      await startDownload({ url, headers, baseName, folder, entryId: ctx.entry.id, tabId: ctx.tabId });
      return { status: 'downloading', state: 'busy', message: `Downloading from ${c.sourceLabel}…`, final: false };
    }
    case 'gate':
    case 'free-page': {
      await registerCapture({ entryId: ctx.entry.id, baseName, folder, hosts: [hostOf(c.url), ...filehosts, 'bandcamp.com', 'bcbits.com'], tabId: ctx.tabId });
      await openTab(c.url, ctx.tabId);
      return {
        status: 'gate',
        state: 'gate',
        message: `Opened ${hostOf(c.url)}. Finish the steps there; the file will be renamed and filed automatically.`,
        final: true,
      };
    }
    case 'bandcamp-page': {
      const info = await inspectTrack(c.url);
      if (info.free) return performAction(ctx, { ...c, kind: 'free-page', url: info.freePage || c.url });
      if (info.purchasable) return performAction(ctx, { ...c, kind: 'cart', payload: { pageUrl: c.url } });
      return performAction(ctx, { ...c, kind: 'link' });
    }
    case 'cart': {
      const pageUrl = c.payload?.pageUrl || c.url;
      if (ctx.settings.paidAction !== 'cart') return performAction(ctx, { ...c, kind: 'link', url: pageUrl });
      const r = await addToCart(pageUrl);
      if (!r.ok) return { status: 'link', state: 'link', message: `Couldn’t add to the Bandcamp cart automatically (${r.reason}). The page is open for you.`, final: true };
      return { status: 'cart', state: 'cart', message: `Added to your Bandcamp cart${r.unverified ? ' (couldn’t confirm, check the cart)' : ''}.`, final: true };
    }
    case 'link':
    default: {
      await openTab(c.url, ctx.tabId);
      return { status: 'link', state: 'link', message: `Opened ${hostOf(c.url)}.`, final: true };
    }
  }
}

async function openTab(url, openerTabId) {
  try {
    await chrome.tabs.create({ url, active: true, ...(openerTabId != null ? { openerTabId } : {}) });
  } catch {
    await chrome.tabs.create({ url, active: true });
  }
}

// ---- search loop -------------------------------------------------------------------------

async function searchSources(ctx) {
  const { settings } = ctx;
  const review = [];
  for (const id of settings.sourceOrder) {
    if (!settings.sources[id]?.enabled) continue;
    if (ctx.onlySources && !ctx.onlySources.includes(id)) continue;
    const label = SOURCE_META[id].label;
    emit(ctx, { state: 'busy', message: `Searching ${label}…` });
    let res;
    try {
      res = await FINDERS[id](ctx);
    } catch (e) {
      ctx.notes.push(`${label}: ${e.message}`);
      continue;
    }
    if (res.status === 'login') {
      ctx.notes.push(`${label}: you’re logged out. Log in there, then retry.`);
      continue;
    }
    if (res.status === 'unconfigured') {
      ctx.notes.push(`${label}: ${res.note}`);
      continue;
    }
    if (res.status === 'error') {
      ctx.notes.push(`${label}: ${res.message}`);
      continue;
    }
    if (res.note) ctx.notes.push(`${label}: ${res.note}`);
    const cands = (res.candidates || []).filter((c) => c.score >= settings.matching.reviewThreshold);
    if (!cands.length) {
      ctx.notes.push(`${label}: no match`);
      continue;
    }
    const best = cands[0];
    if (settings.autoAct && best.score >= settings.matching.autoThreshold && best.kind !== 'link') {
      try {
        const outcome = await performAction(ctx, best);
        return { acted: true, outcome, chosen: best, candidates: cands.slice(0, 5) };
      } catch (e) {
        ctx.notes.push(`${label}: ${e.message}`);
      }
    }
    review.push(...cands.slice(0, 4));
  }
  review.sort((a, b) => b.score - a.score);
  return { acted: false, review: review.slice(0, 8) };
}

async function completeActed(ctx, res) {
  const { outcome, chosen, candidates } = res;
  await store.updateEntry(ctx.entry.id, {
    status: outcome.status,
    source: chosen.source,
    chosen,
    candidates,
    notes: ctx.notes,
    message: outcome.message,
  });
  if (outcome.status === 'cart' || outcome.status === 'gate') await store.updateWant(ctx.scUrl, { status: 'found', foundAt: Date.now() });
  emit(ctx, { state: outcome.state, message: outcome.message, final: outcome.final, candidates });
  return { status: outcome.status };
}

// ---- entry points ---------------------------------------------------------------------------

async function huntTrack(ctx, track, { force = false } = {}) {
  ctx.track = track;
  ctx.query = sc.toQuery(track);
  ctx.label = displayName(ctx.query);
  ctx.scUrl = canonicalScUrl(track.permalink_url) || ctx.scUrl;
  await store.updateEntry(ctx.entry.id, { scId: track.id, scUrl: ctx.scUrl, label: ctx.label, query: slimQuery(ctx.query), artwork: track.artwork_url || '' });

  if (!force) {
    const owned = await store.findOwned(ctx.scUrl, track.id);
    if (owned && owned.id !== ctx.entry.id) {
      const when = new Date(owned.updatedAt || owned.at).toLocaleDateString();
      await store.updateEntry(ctx.entry.id, { status: 'owned', file: owned.file || '' });
      emit(ctx, { state: 'done', message: `Already downloaded (${when}).`, final: true, owned: true });
      return { status: 'owned' };
    }
  }

  const res = await searchSources(ctx);
  if (res.acted) return completeActed(ctx, res);

  if (res.review.length) {
    await store.updateEntry(ctx.entry.id, { status: 'review', candidates: res.review, notes: ctx.notes });
    emit(ctx, { state: 'review', message: 'No sure match. Pick one, or wantlist it:', candidates: res.review, final: true });
    return { status: 'review' };
  }
  if (ctx.settings.wantlist.enabled) {
    await store.addWant({ scUrl: ctx.scUrl, scId: track.id, label: ctx.label, query: slimQuery(ctx.query) });
    await store.updateEntry(ctx.entry.id, { status: 'want', notes: ctx.notes });
    emit(ctx, { state: 'want', message: `Not found anywhere yet. Wantlisted; DJDelivery is re-checked every ${ctx.settings.wantlist.intervalHours}h.`, final: true });
    return { status: 'want' };
  }
  await store.updateEntry(ctx.entry.id, { status: 'error', notes: ctx.notes });
  emit(ctx, { state: 'error', message: 'Not found on any source.', final: true });
  return { status: 'error' };
}

async function runBatch(ctx, playlist) {
  const tracks = await sc.hydrateTracks(playlist.tracks || []);
  const tally = {};
  let i = 0;
  for (const t of tracks) {
    i += 1;
    emit(ctx, { state: 'busy', message: `Set ${i}/${tracks.length}: ${t.title}`, batch: { done: i, total: tracks.length } });
    const scUrl = canonicalScUrl(t.permalink_url);
    const entry = await store.createEntry({ scUrl, origin: 'batch', parent: ctx.entry.id, label: t.title });
    const child = { entry, tabId: ctx.tabId, settings: ctx.settings, scUrl, notes: [], quiet: true };
    let out;
    try {
      out = await huntTrack(child, t);
    } catch (e) {
      await store.updateEntry(entry.id, { status: 'error', notes: [e.message] });
      out = { status: 'error' };
    }
    tally[out.status] = (tally[out.status] || 0) + 1;
  }
  const summary = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing to do';
  await store.updateEntry(ctx.entry.id, { status: 'batch', summary });
  emit(ctx, { state: 'done', message: `Set finished: ${summary}. Details in the toolbar popup.`, final: true });
  return { status: 'batch' };
}

export async function hunt({ url, tabId = null, origin = 'button', force = false }) {
  const settings = await getSettings();
  const scUrl = canonicalScUrl(url);
  if (!scUrl) throw new Error('Not a SoundCloud link');
  let label = scUrl.split('/').slice(-2).join(' / ');
  try {
    label = decodeURIComponent(label);
  } catch {
    // keep the raw path
  }
  const entry = await store.createEntry({ scUrl, origin, label });
  const ctx = { entry, tabId, settings, scUrl, notes: [] };
  emit(ctx, { state: 'busy', message: 'Reading the track from SoundCloud…' });
  try {
    const resolved = await sc.resolve(url);
    if (resolved.kind === 'playlist' || resolved.kind === 'system-playlist') {
      ctx.label = `Set: ${resolved.title}`;
      await store.updateEntry(entry.id, { label: ctx.label });
      return await runBatch(ctx, resolved);
    }
    if (resolved.kind !== 'track') throw new Error(`That link is a ${resolved.kind}, not a track.`);
    return await huntTrack(ctx, resolved, { force });
  } catch (e) {
    await store.updateEntry(entry.id, { status: 'error', notes: [...ctx.notes, e.message] });
    emit(ctx, { state: 'error', message: e.message, final: true });
    return { status: 'error', error: e.message };
  }
}

/** The user picked a candidate from the review list (toast or popup). */
export async function act({ entryId, cid, tabId = null }) {
  const entry = await store.getEntry(entryId);
  if (!entry) throw new Error('That hunt is no longer in history');
  const c = (entry.candidates || []).find((x) => x.cid === cid);
  if (!c) throw new Error('Candidate not found');
  const settings = await getSettings();
  const ctx = { entry, tabId, settings, scUrl: entry.scUrl, notes: entry.notes || [], query: entry.query, label: entry.label };
  try {
    const outcome = await performAction(ctx, c);
    return completeActed(ctx, { outcome, chosen: c, candidates: entry.candidates });
  } catch (e) {
    emit(ctx, { state: 'error', message: e.message, final: true, candidates: entry.candidates });
    throw e;
  }
}

export async function wantFromEntry(entryId) {
  const entry = await store.getEntry(entryId);
  if (!entry?.query) throw new Error('Nothing to wantlist');
  await store.addWant({ scUrl: entry.scUrl, scId: entry.scId, label: entry.label, query: entry.query });
  await store.updateEntry(entryId, { status: 'want' });
  return { ok: true };
}

/** Periodic re-check of wantlisted tracks (default: DJDelivery only). */
export async function recheckWantlist({ force = false } = {}) {
  const settings = await getSettings();
  if (!settings.wantlist.enabled && !force) return { checked: 0, found: 0 };
  const intervalMs = settings.wantlist.intervalHours * 3600 * 1000;
  const due = (await store.listWant())
    .filter((w) => w.status === 'missing' && w.query)
    .filter((w) => force || Date.now() - (w.lastChecked || 0) >= intervalMs * 0.9)
    .slice(0, settings.wantlist.maxPerRun);
  let found = 0;
  for (const w of due) {
    const entry = await store.createEntry({ scUrl: w.scUrl, scId: w.scId, origin: 'wantlist', label: w.label, query: w.query });
    const ctx = {
      entry,
      tabId: null,
      settings: { ...settings, autoAct: settings.wantlist.autoDownload },
      scUrl: w.scUrl,
      notes: [],
      query: w.query,
      label: w.label,
      quiet: true,
      onlySources: settings.wantlist.sources,
    };
    let res;
    try {
      res = await searchSources(ctx);
    } catch (e) {
      res = { acted: false, review: [] };
      ctx.notes.push(e.message);
    }
    await store.updateWant(w.scUrl, { lastChecked: Date.now(), checks: (w.checks || 0) + 1 });
    if (res.acted) {
      found += 1;
      await completeActed(ctx, res);
      await store.updateWant(w.scUrl, { status: 'found', foundAt: Date.now() });
      notify('Wantlist hit', `${w.label}: ${res.outcome.message}`);
    } else if (res.review.length) {
      await store.updateEntry(entry.id, { status: 'review', candidates: res.review, notes: ctx.notes });
      notify('Possible wantlist match', `${w.label}: review it in the DJ Track Hunter popup.`);
    } else {
      await store.deleteEntry(entry.id);
    }
  }
  return { checked: due.length, found };
}

// Download completion -> history, wantlist, and the tab's toast/button.
onDownloadFinished(async ({ meta, ok, file, error }) => {
  const entry = await store.updateEntry(meta.entryId, ok ? { status: 'downloaded', file } : { status: 'failed', error });
  if (!entry) return;
  if (ok) await store.updateWant(entry.scUrl, { status: 'found', foundAt: Date.now() });
  const name = (file || '').split(/[\\/]/).pop();
  sendToTab(meta.tabId, {
    entryId: entry.id,
    scUrl: entry.scUrl,
    label: entry.label,
    state: ok ? 'done' : 'error',
    message: ok ? `Saved ${name}` : `Download failed (${error || 'unknown error'}).`,
    final: true,
    silent: entry.origin === 'batch',
  });
  if (meta.tabId == null && entry.origin === 'wantlist') notify(ok ? 'Downloaded' : 'Download failed', `${entry.label}${ok ? '' : `: ${error}`}`);
});

export { STATUS_TO_STATE };
