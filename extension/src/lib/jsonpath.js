// Minimal JSON path helpers for config-driven pool adapters. Pure; unit tested.

/** Read "a.b.0.c" / "a[0].b"; "x|y" tries alternatives left to right. */
export function getPath(obj, path) {
  if (path == null || path === '') return obj;
  for (const alt of String(path).split('|')) {
    const keys = alt.trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const k of keys) {
      if (cur == null) break;
      cur = cur[k];
    }
    if (cur != null && cur !== '') return cur;
  }
  return undefined;
}

/** Flatten artist arrays, {name} objects, numbers into display text. */
export function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
  if (typeof v === 'object') return asText(v.name ?? v.title ?? v.display_name ?? v.label ?? '');
  return String(v).replace(/\s+/g, ' ').trim();
}

/** "https://x/api/dl/{id}?f={raw.format}" -> filled; values are URI-encoded. */
export function fillTemplate(tpl, item) {
  return String(tpl || '').replace(/\{([^{}]+)\}/g, (_, key) => {
    const k = key.trim();
    const v = k.startsWith('raw.') ? getPath(item.raw, k.slice(4)) : item[k];
    return v == null ? '' : encodeURIComponent(asText(v));
  });
}

function absolutize(u, baseUrl) {
  if (!u) return '';
  try {
    return new URL(u, baseUrl).href;
  } catch {
    return '';
  }
}

/** Map a JSON search response to the same row shape the HTML extractor produces. */
export function mapJsonItems(json, cfg, baseUrl) {
  const list = getPath(json, cfg.itemsPath);
  if (!Array.isArray(list)) return [];
  // An unmapped field is empty, never the whole row (getPath('') returns the object itself).
  const field = (raw, path) => (path ? asText(getPath(raw, path)) : '');
  return list.slice(0, cfg.maxRows || 50).map((raw, index) => {
    const item = {
      index,
      raw,
      artist: field(raw, cfg.artist),
      title: field(raw, cfg.title),
      version: field(raw, cfg.version),
      id: field(raw, cfg.id),
      bpm: field(raw, cfg.bpm),
      key: field(raw, cfg.key),
      genre: field(raw, cfg.genre),
      isrc: field(raw, cfg.isrc),
    };
    item.downloadUrl = absolutize(field(raw, cfg.download), baseUrl);
    return item;
  }).filter((it) => it.title || it.artist);
}

const FIELD_HINTS = {
  title: [/^(title|track_?title|song_?title|name|track_?name|song)$/i, /title/i],
  artist: [/^(artist|artists|artist_?name|artist_?display|performer|display_?artist)$/i, /artist/i],
  version: [/^(version|mix|mix_?name|remix|edit|type|version_?name)$/i, /(version|mix)/i],
  id: [/^(id|track_?id|uuid|_id|media_?id)$/i, /(^|_)id$/i],
  download: [/^(download|download_?url|download_?link|dl_?url|file_?url)$/i, /download/i, /^(url|file|wav|mp3|aiff|flac)$/i],
  bpm: [/^(bpm|tempo)$/i],
  key: [/^(key|musical_?key|camelot|key_?name)$/i],
  genre: [/^(genre|genres|genre_?name)$/i],
  isrc: [/^isrc$/i],
};

function walkArrays(node, path, out, depth) {
  if (depth > 6 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x))) out.push({ path, arr: node });
    node.slice(0, 1).forEach((x, i) => walkArrays(x, path ? `${path}.${i}` : String(i), [], depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(node)) walkArrays(v, path ? `${path}.${k}` : k, out, depth + 1);
}

function pickField(sample, hints) {
  const entries = Object.entries(sample);
  for (const re of hints) {
    const hit = entries.find(([k, v]) => re.test(k) && v != null && (typeof v !== 'object' || Array.isArray(v) || 'name' in v));
    if (hit) return hit[0];
  }
  return '';
}

/**
 * Guess { itemsPath, fields } from a pasted search-response sample.
 * Picks the array of objects whose items look most like tracks.
 */
export function autodetectMapping(sample) {
  const arrays = [];
  walkArrays(sample, '', arrays, 0);
  let best = null;
  for (const { path, arr } of arrays) {
    const first = arr[0];
    const fields = {};
    let score = 0;
    for (const [field, hints] of Object.entries(FIELD_HINTS)) {
      fields[field] = pickField(first, hints);
      if (fields[field]) score += field === 'title' || field === 'artist' ? 3 : 1;
    }
    score += Math.min(arr.length, 10) / 10;
    if (!best || score > best.score) best = { itemsPath: path, fields, score };
  }
  if (!best || !best.fields.title) return null;
  return { itemsPath: best.itemsPath, fields: best.fields };
}
