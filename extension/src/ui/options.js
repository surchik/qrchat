import { DEFAULTS, SOURCE_META, getSettings, saveSettings, deepMerge } from '../lib/settings.js';
import { getPath, autodetectMapping } from '../lib/jsonpath.js';

const $ = (s) => document.querySelector(s);
let settings;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || 'No response');
  return res.result;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = cur[k] ??= {};
  cur[keys.at(-1)] = value;
}

// ---- field specs ---------------------------------------------------------------------------

const GENERAL = [
  { sub: 'Behaviour' },
  { path: 'autoAct', type: 'bool', label: 'Act automatically', help: 'Download / open gate / add to cart on a confident match. Off = always show the candidate list.' },
  { path: 'matching.autoThreshold', type: 'number', step: 0.01, label: 'Confident match ≥', help: '0–1. Higher = fewer wrong versions, more manual picks. 0.82 is a sane start.' },
  { path: 'matching.reviewThreshold', type: 'number', step: 0.01, label: 'Show as candidate ≥', help: 'Matches between this and the confident threshold are listed for you to pick.' },
  { path: 'paidAction', type: 'select', label: 'Paid Bandcamp match', options: [['cart', 'Add to cart automatically'], ['link', 'Only open the page']] },
  { sub: 'Files' },
  { path: 'files.folder', type: 'text', label: 'Folder (inside Downloads)', help: 'Placeholders: {source} {date} {genre}. Chrome can only save inside your Downloads folder.' },
  { path: 'files.filename', type: 'text', label: 'File name', help: 'Placeholders: {artist} {title} {mix} {label} {genre}. "{ (mix)}" adds " (Extended Mix)" only when there is a mix.' },
];

const POOL = [
  { sub: 'Connection' },
  { path: 'djdelivery.baseUrl', type: 'text', label: 'Site URL' },
  { path: 'djdelivery.searchUrl', type: 'text', label: 'Search URL', help: 'Use {query} where the search text goes, e.g. https://djdelivery.com/search?q={query}' },
  { path: 'djdelivery.transport', type: 'select', label: 'Fetch method', options: [['background', 'Background (cookies), the fastest'], ['tab-fetch', 'From a DJDelivery tab (token in localStorage)'], ['tab-render', 'Render page in a hidden tab (JS-only sites)']] },
  { path: 'djdelivery.format', type: 'select', label: 'Search response', options: [['html', 'HTML page'], ['json', 'JSON API']] },
  { path: 'djdelivery.queryTemplates', type: 'list', label: 'Queries to try', help: 'One per line, tried in order until one returns results. {artist} {title} {mix} {fullartist}' },
  { path: 'djdelivery.loginUrlIncludes', type: 'text', label: 'Login URL contains', help: 'If a request ends up on a URL containing this, you are treated as logged out.' },
  { path: 'djdelivery.loginSelector', type: 'text', label: 'Login page selector', help: 'CSS that only exists on the login page (HTML mode).' },
  { sub: 'HTML results (CSS selectors; "sel@attr" reads an attribute)' },
  { path: 'djdelivery.html.row', type: 'text', label: 'Result row', help: 'Selector matching one element per track/version row.' },
  { path: 'djdelivery.html.artist', type: 'text', label: 'Artist' },
  { path: 'djdelivery.html.title', type: 'text', label: 'Title' },
  { path: 'djdelivery.html.version', type: 'text', label: 'Version / mix' },
  { path: 'djdelivery.html.download', type: 'text', label: 'Download link', help: 'e.g. a.download@href' },
  { path: 'djdelivery.html.id', type: 'text', label: 'Track id', help: 'e.g. @data-id (attribute on the row), for download URL templates.' },
  { path: 'djdelivery.html.bpm', type: 'text', label: 'BPM' },
  { path: 'djdelivery.html.key', type: 'text', label: 'Key' },
  { path: 'djdelivery.html.genre', type: 'text', label: 'Genre' },
  { sub: 'JSON results (dotted paths; "a|b" = first non-empty)' },
  { path: 'djdelivery.json.itemsPath', type: 'text', label: 'Items array path', help: 'e.g. data.tracks (empty = the response is the array).' },
  { path: 'djdelivery.json.artist', type: 'text', label: 'Artist' },
  { path: 'djdelivery.json.title', type: 'text', label: 'Title' },
  { path: 'djdelivery.json.version', type: 'text', label: 'Version / mix' },
  { path: 'djdelivery.json.download', type: 'text', label: 'Download URL' },
  { path: 'djdelivery.json.id', type: 'text', label: 'Track id' },
  { path: 'djdelivery.json.bpm', type: 'text', label: 'BPM' },
  { path: 'djdelivery.json.key', type: 'text', label: 'Key' },
  { path: 'djdelivery.json.isrc', type: 'text', label: 'ISRC' },
  { sub: 'Download' },
  { path: 'djdelivery.download.urlTemplate', type: 'text', label: 'Download URL template', help: 'Used when rows have no link, e.g. https://djdelivery.com/download/{id}' },
  { path: 'djdelivery.download.method', type: 'select', label: 'Download request', options: [['GET', 'GET'], ['POST', 'POST']] },
  { path: 'djdelivery.download.resolveJsonPath', type: 'text', label: 'Signed URL path', help: 'If the download endpoint answers with JSON like {"url": "https://cdn…"}, the path to that URL (e.g. url or data.link).' },
  { path: 'djdelivery.auth.localStorageKey', type: 'text', label: 'Token localStorage key', help: 'Only for “From a DJDelivery tab”: where the site keeps its API token.' },
  { path: 'djdelivery.auth.jsonPath', type: 'text', label: 'Token path inside it', help: 'If the stored value is JSON, e.g. state.accessToken' },
  { sub: 'Versions & pacing' },
  { path: 'djdelivery.versionPrefer', type: 'list', label: 'Preferred versions', help: 'First match wins among versions of the same track.' },
  { path: 'djdelivery.versionAvoid', type: 'list', label: 'Avoid versions', help: 'Skipped unless the SoundCloud title asks for them.' },
  { path: 'djdelivery.minIntervalMs', type: 'number', step: 100, label: 'Min ms between searches', help: 'Keeps you from looking like a bot. 3000+ recommended.' },
  { path: 'djdelivery.dailyDownloadCap', type: 'number', step: 1, label: 'Daily download cap', help: 'Hard stop for the extension (0 = none). Set it below your pool’s own limit.' },
];

const MORE = [
  { sub: 'Wantlist' },
  { path: 'wantlist.enabled', type: 'bool', label: 'Wantlist tracks not found' },
  { path: 'wantlist.intervalHours', type: 'number', step: 1, label: 'Re-check every (hours)' },
  { path: 'wantlist.maxPerRun', type: 'number', step: 1, label: 'Tracks per re-check' },
  { path: 'wantlist.autoDownload', type: 'bool', label: 'Auto-download when found' },
  { path: 'wantlist.sources', type: 'list', label: 'Sources to re-check', help: `Source ids, one per line: ${Object.keys(SOURCE_META).join(', ')}` },
  { sub: 'Free-download link detection (domains, one per line)' },
  { path: 'freeDomains.gate', type: 'list', label: 'Download gates', help: 'Opened automatically; the resulting file is captured and renamed.' },
  { path: 'freeDomains.filehost', type: 'list', label: 'File hosts', help: 'Opened automatically when linked from the track.' },
  { path: 'freeDomains.hub', type: 'list', label: 'Link hubs', help: 'Opened only if the text around the link mentions a free download.' },
  { path: 'freeDomains.paidstore', type: 'list', label: 'Paid stores', help: 'Listed as “also sold on…” but never auto-opened.' },
  { sub: 'Diagnostics' },
  { path: 'discovery.enabled', type: 'bool', label: 'Discovery mode', help: 'Log DJDelivery page/API requests (no bodies) to help configure the adapter.' },
];

function renderForm(container, spec) {
  container.replaceChildren();
  for (const f of spec) {
    if (f.sub) {
      container.append(h('div', { class: 'sub' }, f.sub));
      continue;
    }
    const id = `f-${f.path.replace(/\./g, '-')}`;
    const v = getPath(settings, f.path);
    let input;
    if (f.type === 'bool') input = h('input', { id, type: 'checkbox', checked: !!v, style: 'width:auto' });
    else if (f.type === 'select') input = h('select', { id }, f.options.map(([val, text]) => h('option', { value: val, selected: v === val }, text)));
    else if (f.type === 'list') input = h('textarea', { id, rows: Math.min(6, Math.max(2, (v || []).length)) });
    else input = h('input', { id, type: f.type === 'number' ? 'number' : 'text', step: f.step });
    if (f.type === 'list') input.value = (v || []).join('\n');
    else if (f.type !== 'bool' && f.type !== 'select') input.value = v ?? '';
    input.dataset.path = f.path;
    input.dataset.type = f.type;
    container.append(h('label', { for: id }, f.label), input);
    if (f.help) container.append(h('div', { class: 'help' }, f.help));
  }
}

function readForms() {
  const next = structuredClone(settings);
  for (const el of document.querySelectorAll('[data-path]')) {
    const { path, type } = el.dataset;
    let v;
    if (type === 'bool') v = el.checked;
    else if (type === 'number') v = el.value === '' ? 0 : Number(el.value);
    else if (type === 'list') v = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    else v = el.value.trim();
    setPath(next, path, v);
  }
  return next;
}

function renderSources() {
  const ul = $('#sources');
  ul.replaceChildren();
  settings.sourceOrder.forEach((id, i) => {
    const meta = SOURCE_META[id];
    const cb = h('input', { type: 'checkbox', checked: !!settings.sources[id]?.enabled, style: 'width:auto' });
    cb.addEventListener('change', () => {
      settings.sources[id] = { ...settings.sources[id], enabled: cb.checked };
    });
    const move = (d) => {
      settings = readForms();
      const j = i + d;
      if (j < 0 || j >= settings.sourceOrder.length) return;
      [settings.sourceOrder[i], settings.sourceOrder[j]] = [settings.sourceOrder[j], settings.sourceOrder[i]];
      renderSources();
    };
    ul.append(h('li', {},
      cb,
      h('span', { class: 'name' }, h('b', {}, meta.label), h('span', { class: 'muted' }, ` · ${meta.description}`)),
      h('button', { class: 'secondary', title: 'Up', onclick: () => move(-1) }, '↑'),
      h('button', { class: 'secondary', title: 'Down', onclick: () => move(1) }, '↓')));
  });
}

function renderAll() {
  renderSources();
  renderForm($('#form-general'), GENERAL);
  renderForm($('#form-pool'), POOL);
  renderForm($('#form-more'), MORE);
}

function status(text) {
  $('#status').textContent = text;
  if (text) setTimeout(() => {
    if ($('#status').textContent === text) $('#status').textContent = '';
  }, 4000);
}

async function save() {
  settings = readForms();
  await saveSettings(settings);
  status('Saved.');
}

// ---- DJDelivery helpers ---------------------------------------------------------------------

function originPattern(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

async function refreshGrant() {
  const pattern = originPattern($('#f-djdelivery-baseUrl').value);
  if (!pattern) return;
  const has = await chrome.permissions.contains({ origins: [pattern] });
  $('#grant-status').textContent = has ? `Access to ${pattern} granted.` : `No access to ${pattern} yet.`;
}

$('#grant').addEventListener('click', async () => {
  const pattern = originPattern($('#f-djdelivery-baseUrl').value);
  if (!pattern) return;
  const ok = await chrome.permissions.request({ origins: [pattern] });
  $('#grant-status').textContent = ok ? `Access to ${pattern} granted.` : 'Access not granted.';
});

$('#test-run').addEventListener('click', async () => {
  await save();
  const q = $('#test-q').value.trim();
  if (!q) return;
  $('#test-status').textContent = 'Searching…';
  $('#test-table').replaceChildren();
  try {
    const r = await send({ type: 'test-pool', q });
    const msg = {
      unconfigured: 'Not configured: set the search URL and the row + title selectors (or the JSON title path).',
      login: 'Looks logged out. Log in to DJDelivery in this browser, then retry.',
      error: `Error: ${r.message}`,
      ok: `${(r.items || []).length} result(s) for “${r.usedQuery || q}”.`,
    }[r.status] || r.status;
    $('#test-status').textContent = msg;
    if (r.items?.length) {
      $('#test-table').append(
        h('tr', {}, ['Score', 'Artist', 'Title', 'Version', 'Download link', 'Why'].map((t) => h('th', {}, t))),
        ...r.items.map((it) => h('tr', {},
          h('td', {}, `${Math.round(it.score * 100)}%`),
          h('td', {}, it.artist),
          h('td', {}, it.title),
          h('td', {}, it.version),
          h('td', { class: 'url' }, it.downloadUrl || (it.id ? `id: ${it.id}` : '–')),
          h('td', { class: 'muted' }, it.reason || ''))));
    }
  } catch (e) {
    $('#test-status').textContent = e.message;
  }
});

$('#json-map').addEventListener('click', () => {
  let sample;
  try {
    sample = JSON.parse($('#json-sample').value);
  } catch {
    $('#json-status').textContent = 'That is not valid JSON.';
    return;
  }
  const m = autodetectMapping(sample);
  if (!m) {
    $('#json-status').textContent = 'Could not find an array of tracks with a title field.';
    return;
  }
  settings = readForms();
  settings.djdelivery.format = 'json';
  settings.djdelivery.json = { ...settings.djdelivery.json, itemsPath: m.itemsPath, ...m.fields };
  renderForm($('#form-pool'), POOL);
  $('#json-status').textContent = `Detected items at "${m.itemsPath || '(root)'}": ${Object.entries(m.fields).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ')}. Review, then Save.`;
});

// ---- discovery ------------------------------------------------------------------------------------

async function renderDiscovery() {
  const log = await send({ type: 'discovery-log' });
  const table = $('#disc-table');
  table.replaceChildren(h('tr', {}, ['Time', 'Method', 'Status', 'Type', 'Content-Type', 'URL'].map((t) => h('th', {}, t))));
  for (const r of [...log].reverse().slice(0, 200)) {
    table.append(h('tr', {},
      h('td', {}, new Date(r.t).toLocaleTimeString()),
      h('td', {}, r.method),
      h('td', {}, r.status),
      h('td', {}, r.type),
      h('td', {}, (r.contentType || '').split(';')[0]),
      h('td', { class: 'url' }, r.url)));
  }
  if (!log.length) table.append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'Empty. Enable Discovery mode, save, then use DJDelivery in another tab.')));
}

$('#disc-refresh').addEventListener('click', renderDiscovery);
$('#disc-clear').addEventListener('click', async () => {
  await send({ type: 'discovery-clear' });
  renderDiscovery();
});
$('#disc-copy').addEventListener('click', async () => {
  const log = await send({ type: 'discovery-log' });
  await navigator.clipboard.writeText(JSON.stringify(log, null, 2));
  status('Discovery log copied.');
});

// ---- backup ---------------------------------------------------------------------------------------

function downloadBlob(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

$('#export').addEventListener('click', () => downloadBlob('dj-track-hunter-settings.json', 'application/json', JSON.stringify(readForms(), null, 2)));
$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    settings = deepMerge(structuredClone(DEFAULTS), JSON.parse(await file.text()));
    await saveSettings(settings);
    renderAll();
    status('Imported.');
  } catch (e) {
    status(`Import failed: ${e.message}`);
  }
});
$('#reset').addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults?')) return;
  settings = structuredClone(DEFAULTS);
  await saveSettings(settings);
  renderAll();
  status('Reset.');
});
$('#export-history').addEventListener('click', async () => {
  const rows = await send({ type: 'list-history', limit: 1000 });
  const cols = ['at', 'status', 'label', 'source', 'file', 'scUrl'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(','))].join('\n');
  downloadBlob('dj-track-hunter-history.csv', 'text/csv', csv);
});

$('#save').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

(async () => {
  $('#ver').textContent = chrome.runtime.getManifest().version;
  settings = await getSettings();
  renderAll();
  $('#f-djdelivery-baseUrl').addEventListener('change', refreshGrant);
  refreshGrant();
  renderDiscovery();
})();
