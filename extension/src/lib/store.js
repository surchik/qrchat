// History and wantlist persistence (chrome.storage.local). Writes are serialized so
// concurrent hunts can't clobber each other's read-modify-write cycles.

const HISTORY_CAP = 1000;
let chain = Promise.resolve();

function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function read(key) {
  const got = await chrome.storage.local.get(key);
  return got[key] || [];
}

export function newId() {
  return crypto.randomUUID();
}

export function createEntry(entry) {
  return serialized(async () => {
    const history = await read('history');
    const full = { id: newId(), at: Date.now(), status: 'searching', notes: [], candidates: [], ...entry };
    history.unshift(full);
    if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
    await chrome.storage.local.set({ history });
    return full;
  });
}

export function updateEntry(id, patch) {
  return serialized(async () => {
    const history = await read('history');
    const i = history.findIndex((h) => h.id === id);
    if (i < 0) return null;
    const next = typeof patch === 'function' ? patch(history[i]) : { ...history[i], ...patch, updatedAt: Date.now() };
    history[i] = next;
    await chrome.storage.local.set({ history });
    return next;
  });
}

export function deleteEntry(id) {
  return serialized(async () => {
    const history = (await read('history')).filter((h) => h.id !== id);
    await chrome.storage.local.set({ history });
  });
}

export async function getEntry(id) {
  return (await read('history')).find((h) => h.id === id) || null;
}

export async function listEntries(limit = 50) {
  return (await read('history')).slice(0, limit);
}

export function clearHistory() {
  return serialized(() => chrome.storage.local.set({ history: [] }));
}

const DONE_STATES = new Set(['downloaded', 'downloading', 'cart', 'gate']);

/** Most relevant status per SoundCloud URL, for button badges. */
export async function statusForUrls(urls) {
  const want = new Set(urls);
  const out = {};
  for (const h of await read('history')) {
    if (!want.has(h.scUrl) || out[h.scUrl]) continue;
    if (DONE_STATES.has(h.status) || h.status === 'review') out[h.scUrl] = h.status;
  }
  for (const w of await read('wantlist')) {
    if (want.has(w.scUrl) && !out[w.scUrl] && w.status === 'missing') out[w.scUrl] = 'want';
  }
  return out;
}

export async function findOwned(scUrl, scId) {
  // 'downloading' only counts while fresh: a download lost to a browser restart must not
  // make the track look owned forever.
  const fresh = (h) => h.status === 'downloaded' || (h.status === 'downloading' && Date.now() - (h.updatedAt || h.at) < 60 * 60 * 1000);
  return (await read('history')).find((h) => (h.scUrl === scUrl || (scId && h.scId === scId)) && fresh(h)) || null;
}

export function addWant(item) {
  return serialized(async () => {
    const wantlist = await read('wantlist');
    const existing = wantlist.find((w) => w.scUrl === item.scUrl);
    if (existing) {
      Object.assign(existing, { status: 'missing', query: item.query, label: item.label });
    } else {
      wantlist.unshift({ addedAt: Date.now(), lastChecked: 0, checks: 0, status: 'missing', ...item });
    }
    await chrome.storage.local.set({ wantlist });
  });
}

export function updateWant(scUrl, patch) {
  return serialized(async () => {
    const wantlist = await read('wantlist');
    const w = wantlist.find((x) => x.scUrl === scUrl);
    if (w) Object.assign(w, patch);
    await chrome.storage.local.set({ wantlist });
  });
}

export function removeWant(scUrl) {
  return serialized(async () => {
    const wantlist = (await read('wantlist')).filter((w) => w.scUrl !== scUrl);
    await chrome.storage.local.set({ wantlist });
  });
}

export async function listWant() {
  return read('wantlist');
}
