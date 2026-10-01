// DOM extractors. Each exported function is fully self-contained (no imports, no outer
// references) because it is also serialized into pages via chrome.scripting.executeScript.
// Pass `root = null` to operate on the live `document`.

/**
 * Pull result rows out of a pool's search page using CSS selectors from settings.
 * Field specs: "css selector" -> text, "css selector@attr" -> attribute, "@attr" -> attribute on the row.
 */
export function extractRows(root, cfg, baseUrl) {
  const doc = root || document;
  const read = (scope, spec) => {
    if (!spec) return '';
    let sel = spec;
    let attr = null;
    const at = spec.lastIndexOf('@');
    if (at >= 0 && /^[\w-]+$/.test(spec.slice(at + 1).trim())) {
      sel = spec.slice(0, at).trim();
      attr = spec.slice(at + 1).trim();
    }
    let el = scope;
    if (sel) {
      try {
        el = scope.querySelector(sel);
      } catch (e) {
        return '';
      }
    }
    if (!el) return '';
    const v = attr ? el.getAttribute(attr) : el.textContent;
    return String(v || '').replace(/\s+/g, ' ').trim();
  };
  const abs = (u) => {
    if (!u) return '';
    try {
      return new URL(u, baseUrl || doc.baseURI).href;
    } catch (e) {
      return '';
    }
  };
  let loginDetected = false;
  if (cfg.loginSelector) {
    try {
      loginDetected = !!doc.querySelector(cfg.loginSelector);
    } catch (e) {
      loginDetected = false;
    }
  }
  let rows = [];
  if (cfg.row) {
    try {
      rows = Array.from(doc.querySelectorAll(cfg.row));
    } catch (e) {
      return { loginDetected, rowCount: 0, items: [], error: `Bad row selector: ${cfg.row}` };
    }
  }
  const items = rows.slice(0, cfg.maxRows || 50).map((row, index) => ({
    index,
    artist: read(row, cfg.artist),
    title: read(row, cfg.title),
    version: read(row, cfg.version),
    id: read(row, cfg.id),
    downloadUrl: abs(read(row, cfg.download)),
    bpm: read(row, cfg.bpm),
    key: read(row, cfg.key),
    genre: read(row, cfg.genre),
    isrc: read(row, cfg.isrc),
  })).filter((it) => it.title || it.artist);
  return { loginDetected, rowCount: rows.length, items };
}

/** Bandcamp search page (https://bandcamp.com/search?q=...&item_type=t). */
export function parseBandcampSearch(root) {
  const doc = root || document;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const lis = Array.from(doc.querySelectorAll('.result-items li, li.searchresult'));
  const seen = new Set();
  const out = [];
  for (const li of lis) {
    const type = clean(li.querySelector('.itemtype') && li.querySelector('.itemtype').textContent).toLowerCase();
    const a = li.querySelector('.heading a');
    const title = clean(a ? a.textContent : (li.querySelector('.heading') || {}).textContent);
    const sub = clean((li.querySelector('.subhead') || {}).textContent);
    let artist = sub;
    let album = '';
    const m = sub.match(/^(?:from\s+(.*?)\s+)?by\s+(.*)$/i);
    if (m) {
      album = m[1] || '';
      artist = m[2];
    }
    const itemurl = li.querySelector('.itemurl a') || li.querySelector('.itemurl');
    let url = clean((itemurl && (itemurl.getAttribute('href') || itemurl.textContent)) || (a && a.getAttribute('href')) || '');
    url = url.split('?')[0];
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, '')}`;
    if (!url || seen.has(url) || (type && type !== 'track')) continue;
    seen.add(url);
    out.push({ type: type || 'track', title, artist, album, url });
  }
  return out;
}

/** The JSON blob Bandcamp embeds in track/album pages (script[data-tralbum]). */
export function parseBandcampTralbum(root) {
  const doc = root || document;
  const el = doc.querySelector('script[data-tralbum]');
  if (!el) return null;
  try {
    return JSON.parse(el.getAttribute('data-tralbum'));
  } catch (e) {
    return null;
  }
}
