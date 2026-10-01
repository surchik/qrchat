// Find artist-provided download links on a SoundCloud track (buy link + description).
// Pure; unit tested.

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const BARE_RE = /(?:^|[\s(:])((?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|io|co|to|ee|it|nz|tl|link|ly)\/[^\s<>"'`)\]]+)/gi;
const FREE_LABEL_RE = /\bfree\b|\bgratis\b|\bdescarga\b|\bdownload\b|\bdl\b|\bwav\b/i;

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function hostMatches(host, domains) {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function classifyHost(host, freeDomains) {
  for (const kind of ['gate', 'filehost', 'hub', 'paidstore']) {
    if (hostMatches(host, freeDomains[kind] || [])) return kind;
  }
  if (host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) return 'bandcamp';
  return '';
}

function trimUrl(u) {
  return u.replace(/[.,;:!?]+$/, '');
}

/**
 * @returns {Array<{url:string, host:string, kind:string, from:'purchase_url'|'description', labelledFree:boolean}>}
 *   kind: gate | filehost | bandcamp | hub | paidstore | other
 */
export function findTrackLinks(track, freeDomains) {
  const out = [];
  const seen = new Set();
  const add = (rawUrl, from, labelledFree, line = '') => {
    const url = trimUrl(/^https?:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
    const host = hostOf(url);
    if (!host || seen.has(url) || /(^|\.)soundcloud\.com$/.test(host) || host === 'on.soundcloud.com') return;
    seen.add(url);
    out.push({ url, host, kind: classifyHost(host, freeDomains) || 'other', from, labelledFree, line });
  };

  if (track?.purchase_url) {
    add(track.purchase_url, 'purchase_url', FREE_LABEL_RE.test(track.purchase_title || ''));
  }
  const desc = String(track?.description || '');
  for (const m of desc.matchAll(URL_RE)) add(m[0], 'description', lineSaysFree(desc, m.index), lineAt(desc, m.index));
  for (const m of desc.matchAll(BARE_RE)) {
    const candidate = m[1];
    if (![...seen].some((s) => s.includes(candidate))) add(candidate, 'description', lineSaysFree(desc, m.index), lineAt(desc, m.index));
  }
  return out;
}

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? undefined : end);
}

function lineSaysFree(text, index) {
  return FREE_LABEL_RE.test(lineAt(text, index).replace(URL_RE, ''));
}

/** Whether a link is worth opening automatically (vs. listing for review). */
export function isActionableFreeLink(link) {
  if (link.kind === 'gate' || link.kind === 'bandcamp') return true;
  if (link.kind === 'filehost') return true;
  if (link.kind === 'hub' || link.kind === 'other') return link.labelledFree;
  return false;
}
