// SoundCloud web API (api-v2), used the same way soundcloud.com's own web player uses it:
// a public client_id plus your logged-in session's OAuth token from the oauth_token cookie.
// Endpoint shapes follow yt-dlp's SoundCloud extractor (resolve, search/tracks, tracks/{id}/download).

import { parseSoundCloudTrack } from '../lib/normalize.js';

const API = 'https://api-v2.soundcloud.com/';
const CLIENT_ID_RE = /^[0-9a-zA-Z]{32}$/;

/** webRequest observer: the web player sends client_id on every API call; remember it. */
export function captureClientId(details) {
  try {
    const id = new URL(details.url).searchParams.get('client_id');
    if (id && CLIENT_ID_RE.test(id)) chrome.storage.session.set({ scClientId: id });
  } catch {
    // ignore malformed URLs
  }
}

async function scrapeClientId() {
  const html = await (await fetch('https://soundcloud.com/', { credentials: 'omit' })).text();
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const src of scripts.reverse()) {
    const js = await (await fetch(src)).text();
    const m = js.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/);
    if (m) return m[1];
  }
  throw new Error('Could not find a SoundCloud client_id. Open soundcloud.com and play anything, then retry.');
}

export async function getClientId({ refresh = false } = {}) {
  if (!refresh) {
    const { scClientId } = await chrome.storage.session.get('scClientId');
    if (scClientId) return scClientId;
  }
  const id = await scrapeClientId();
  await chrome.storage.session.set({ scClientId: id });
  return id;
}

async function authHeaders() {
  const cookie = await chrome.cookies.get({ url: 'https://soundcloud.com', name: 'oauth_token' });
  return cookie?.value ? { Authorization: `OAuth ${cookie.value}` } : {};
}

export async function isLoggedIn() {
  return !!(await authHeaders()).Authorization;
}

export async function api(path, params = {}, { retried = false, retryAuth = true } = {}) {
  const clientId = await getClientId({ refresh: retried });
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  url.searchParams.set('client_id', clientId);
  const res = await fetch(url.href, { headers: { Accept: 'application/json', ...(await authHeaders()) } });
  // A rotated client_id shows up as 401/403: refresh it once.
  if ((res.status === 401 || res.status === 403) && !retried && retryAuth) return api(path, params, { retried: true });
  if (!res.ok) {
    const err = new Error(`SoundCloud API ${res.status} on ${url.pathname}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function resolve(url) {
  return api('resolve', { url });
}

export async function searchTracks(q, limit = 20) {
  const res = await api('search/tracks', { q, limit });
  return res?.collection || [];
}

/** Playlists only embed full objects for the first few tracks; fetch the rest by id. */
export async function hydrateTracks(tracks) {
  const missing = tracks.filter((t) => !t.title).map((t) => t.id);
  const full = new Map(tracks.filter((t) => t.title).map((t) => [t.id, t]));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = await api('tracks', { ids: missing.slice(i, i + 50).join(',') });
    for (const t of batch || []) full.set(t.id, t);
  }
  return tracks.map((t) => full.get(t.id)).filter(Boolean);
}

/** Original file for tracks where the artist enabled downloads. */
export async function originalDownloadUrl(track) {
  let res;
  try {
    res = await api(`tracks/${track.id}/download`, {}, { retryAuth: false });
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new Error('Log in to SoundCloud in this browser to use the artist’s download button.');
    throw e;
  }
  if (!res?.redirectUri) throw new Error('SoundCloud returned no download link');
  return res.redirectUri;
}

export function toQuery(track) {
  return parseSoundCloudTrack(track);
}
