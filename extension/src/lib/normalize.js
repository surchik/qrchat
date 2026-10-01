// Title parsing and string normalization shared by matching and adapters.
// Everything here is pure (no chrome.* calls) so it can be unit tested in Node.

const VERSION_WORDS = [
  'remix', 'rmx', 'mix', 'edit', 're-edit', 'reedit', 'rework', 're-work', 'bootleg', 'flip', 'vip',
  'dub', 'refix', 'version', 'extended', 'original', 'radio', 'club', 'instrumental', 'acapella',
  'a cappella', 'acappella', 'intro', 'outro', 'clean', 'dirty', 'redrum', 'cover', 'mashup',
  'blend', 'reprise', 'remaster', 'remastered', 'live', 'quick hit', 'transition', 'hype', 'short',
  'main', 'explicit', 'redo', 'retouch', 'reconstruction', 'interpretation', 'sped up', 'slowed',
  'nightcore', 'karaoke', 'reverb',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VERSION_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${VERSION_WORDS.map(escapeRe).join('|')})(?:$|[^\\p{L}\\p{N}])`, 'iu');

// Bracket contents that carry no information about the recording itself.
const NOISE_GROUP_RE = /^(?:free\b|free\s*(?:dl|d\/l|download)|out\s*now|premiere|exclusive|preview|teaser|snippet|clip|buy\b|support(?:ed)?\s+by|played\s+by|forthcoming|coming\s+soon|tiktok|viral|hq\b|hd\b|\d{4}$|official|audio\b|video\b|visuali[sz]er|lyrics?\b|click\s+buy|download\s+link|link\s+in|\*+$)/i;

const PREFIX_NOISE_RE = /^\s*(?:[[(]?\s*(?:premiere|exclusive|free\s*(?:dl|d\/l|download)|out\s*now|preview|new|world\s+premiere)\s*[\])]?\s*(?:[:|\-–—]\s*|\s+(?=[[(])))+/i;
const TRAILING_NOISE_RE = /\s*[|*~!/]*\s*(?:free\s*(?:dl|d\/l|download)|out\s*now|buy\s*=\s*free\s*(?:dl|download)?)\s*[|*~!]*\s*$/i;
const LEADING_FREE_RE = /^\s*[|*~!]*\s*free\s*(?:dl|d\/l|download)\s*[|*~!:]*\s*/i;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
const FEAT_RE = /[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+?)\s*(?:[)\]]|$|(?=\s[-–—]\s))/i;
const ARTIST_TITLE_SPLIT_RE = /\s+[-–—]+\s+/;

// Words in a mix name that describe the kind of version rather than who made it.
const GENERIC_MIX_WORDS = new Set([
  'extended', 'original', 'radio', 'club', 'instrumental', 'dub', 'vip', 'intro', 'outro', 'clean',
  'dirty', 'main', 'short', 'long', 'album', 'single', 'full', 'edit', 'mix', 'version', 'remix',
  'bootleg', 'rework', 'flip', 'acapella', 'live', 'remaster', 'remastered', 'explicit', 'quick',
  'hit', 'hype', 'transition', 'redrum', '12', '7', 'inch', 'the', 'a', 'my', 'special', 'new',
  'vocal', 'deluxe', 'piano', 'acoustic', 'slowed', 'reverb', 'sped', 'up', 'super', 'and',
]);

const COLLAB_SPLIT_RE = /\s*(?:,|&|\+|\/|\band\b|\bx\b|\bvs\.?(?=\s)|\bwith\b|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bfeaturing\b|\bpres\.?(?=\s)|\bpresents\b)\s*/i;

/** Lowercase, strip accents and punctuation, keep letters/digits from any script. */
export function normalizeText(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const TOKEN_STOP = new Set(['feat', 'ft', 'featuring', 'and', 'x', 'vs', 'with', 'the']);

export function tokens(s, { keepStop = false } = {}) {
  const out = normalizeText(s).split(' ').filter(Boolean);
  return keepStop ? out : out.filter((t) => !TOKEN_STOP.has(t));
}

export function splitArtists(s) {
  return String(s || '')
    .split(COLLAB_SPLIT_RE)
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Pull "(...)" / "[...]" / "{...}" / "【...】" groups out of a string. */
export function bracketGroups(s) {
  const groups = [];
  const re = /[([{【]([^()[\]{}【】]*)[)\]}】]/g;
  let m;
  while ((m = re.exec(s))) groups.push({ full: m[0], inner: m[1].trim(), index: m.index });
  return groups;
}

export function isVersionText(s) {
  return VERSION_RE.test(` ${s} `);
}

export function isNoiseText(s) {
  const t = String(s || '').trim();
  return !t || NOISE_GROUP_RE.test(t);
}

/**
 * Classify a mix name. Returns one of:
 * '' (none), 'original', 'extended', 'radio', 'remix', 'edit', 'bootleg', 'vip', 'dub',
 * 'instrumental', 'acapella', 'live', 'other'.
 */
export function classifyMix(mix) {
  const t = normalizeText(mix);
  if (!t) return '';
  if (/\b(acapella|a cappella|acappella)\b/.test(t)) return 'acapella';
  if (/\binstrumental\b/.test(t)) return 'instrumental';
  if (/\bvip\b/.test(t)) return 'vip';
  if (/\b(cover|karaoke|sped up|slowed|nightcore|reverb)\b/.test(t)) return 'cover';
  if (/\b(bootleg|flip|mashup|blend|redrum)\b/.test(t)) return 'bootleg';
  if (/\b(remix|rmx|rework|re work|refix|reconstruction|interpretation|redo|retouch)\b/.test(t)) return 'remix';
  if (/\bdub\b/.test(t)) return 'dub';
  if (/\blive\b/.test(t)) return 'live';
  if (/\bextended\b/.test(t)) return 'extended';
  if (/\bradio\b/.test(t)) return 'radio';
  if (/\b(original|main|club|remaster|remastered)\b/.test(t)) return 'original';
  if (/\b(edit|re edit|reedit)\b/.test(t)) return 'edit';
  if (/\b(clean|dirty|intro|outro|explicit|quick hit|hype|transition|short)\b/.test(t)) return 'original';
  return 'other';
}

/**
 * Names of the people credited in a mix, e.g. "Fred again.. & Skrillex Remix" -> ["Fred again..", "Skrillex"].
 * Generic descriptors ("Extended Mix", "Radio Edit", "Dub") yield [].
 */
export function extractRemixers(mix) {
  const m = String(mix || '').match(/^(.*?)\s*\b(?:remix|rmx|edit|re-?edit|rework|re-work|bootleg|flip|refix|dub|vip|mix|version|reconstruction|interpretation|redo|retouch)\b/i);
  if (!m || !m[1]) return [];
  return splitArtists(m[1])
    .map((name) => name.replace(/['’]s$/i, '').trim())
    .filter((name) => {
      const toks = tokens(name, { keepStop: true });
      return toks.length && !toks.every((t) => GENERIC_MIX_WORDS.has(t) || /^\d+$/.test(t));
    });
}

/**
 * Split a bare title into { title, mix, featuring, label } by pulling version and noise
 * groups out of brackets. Works for SoundCloud titles and pool/store rows alike.
 */
export function splitTitleMix(rawTitle) {
  let title = String(rawTitle || '');
  const mixes = [];
  const featuring = [];
  let label = '';

  for (const g of bracketGroups(title)) {
    if (isNoiseText(g.inner)) {
      title = title.replace(g.full, ' ');
    } else if (/^(?:feat\.?|ft\.?|featuring)\s+/i.test(g.inner)) {
      featuring.push(...splitArtists(g.inner.replace(/^(?:feat\.?|ft\.?|featuring)\s+/i, '')));
      title = title.replace(g.full, ' ');
    } else if (isVersionText(g.inner)) {
      mixes.push(g.inner);
      title = title.replace(g.full, ' ');
    } else if (g.full.startsWith('[') || g.full.startsWith('【')) {
      // Square brackets without version words are almost always a label or catalog tag.
      label = label || g.inner;
      title = title.replace(g.full, ' ');
    }
  }

  const feat = title.match(FEAT_RE);
  if (feat) {
    featuring.push(...splitArtists(feat[1]));
    title = title.replace(feat[0], ' ');
  }

  // A trailing " - Extended Mix" style suffix (common on stores and pools).
  const dashMix = title.match(/\s[-–—]\s([^-–—]+)$/);
  if (dashMix && isVersionText(dashMix[1]) && !mixes.length) {
    mixes.push(dashMix[1].trim());
    title = title.slice(0, dashMix.index);
  }

  return {
    title: cleanSpaces(title),
    mix: cleanSpaces(mixes.join(' ')),
    featuring: featuring.map(cleanSpaces).filter(Boolean),
    label: cleanSpaces(label),
  };
}

function cleanSpaces(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|:~*]+|[\s\-–—|:~*]+$/g, '')
    .trim();
}

/** Strip promo junk from a raw SoundCloud title. */
export function stripNoise(raw) {
  let t = String(raw || '');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, ' ');
  t = t.replace(HASHTAG_RE, ' ');
  t = t.replace(/^\s*\d{1,3}\s*[.)]\s+/, ''); // "01. Artist - Title"
  t = t.replace(PREFIX_NOISE_RE, '');
  t = t.replace(LEADING_FREE_RE, '');
  t = t.replace(TRAILING_NOISE_RE, '');
  t = t.replace(/\s+\/{1,2}\s*$/, '');
  return cleanSpaces(t);
}

/**
 * Turn a SoundCloud API track object into a search query.
 * @returns {{artist:string, title:string, mix:string, remixers:string[], featuring:string[],
 *   label:string, isrc:string, durationSec:number|null, uploader:string, raw:string, genre:string}}
 */
export function parseSoundCloudTrack(track) {
  const raw = String(track?.title || '');
  const uploader = String(track?.user?.username || '');
  const pub = track?.publisher_metadata || {};
  const cleaned = stripNoise(raw);

  let artist = '';
  let rest = cleaned;
  const split = cleaned.split(ARTIST_TITLE_SPLIT_RE);
  const quoted = cleaned.match(/^([^"“”]+?)\s+["“]([^"“”]+)["”]\s*(.*)$/);
  if (split.length >= 2 && split[0].trim()) {
    artist = split[0];
    rest = split.slice(1).join(' - ');
  } else if (quoted) {
    // FISHER "LOSING IT" style.
    artist = quoted[1];
    rest = `${quoted[2]} ${quoted[3]}`.trim();
  } else {
    artist = pub.artist || uploader;
  }

  const parts = splitTitleMix(rest);
  let featuring = parts.featuring;
  const artistFeat = String(artist).match(FEAT_RE);
  if (artistFeat) {
    featuring = featuring.concat(splitArtists(artistFeat[1]));
    artist = artist.replace(artistFeat[0], ' ');
  }
  // A label tag sitting in the artist slot, e.g. "[Defected] Artist - Title".
  const artistParts = splitTitleMix(artist);
  artist = artistParts.title;
  const label = parts.label || artistParts.label || pub.p_line_for_display || '';

  const mix = parts.mix;
  return {
    artist: cleanSpaces(artist),
    title: parts.title,
    mix,
    remixers: extractRemixers(mix),
    featuring,
    label: cleanSpaces(label),
    isrc: String(pub.isrc || '').toUpperCase(),
    durationSec: track?.full_duration || track?.duration ? Math.round((track.full_duration || track.duration) / 1000) : null,
    uploader,
    raw,
    genre: String(track?.genre || ''),
  };
}

/** "Artist - Title (Mix)" for display and filenames. */
export function displayName(q) {
  const base = [q.artist, q.title].filter(Boolean).join(' - ');
  return q.mix ? `${base} (${q.mix})` : base;
}

/** Make a string safe as a single path segment on Windows, macOS and Linux. */
export function sanitizeSegment(s, max = 120) {
  let out = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = `_${out}`;
  if (out.length > max) out = out.slice(0, max).trim();
  return out || 'untitled';
}

/** Fill "{artist} - {title}" style templates. Missing keys collapse cleanly. */
export function renderTemplate(tpl, vars) {
  const out = String(tpl || '').replace(/\{([^{}]*)\}/g, (_, expr) => {
    // "{ (mix)}" style: literal text around a key, emitted only when the key has a value.
    const m = expr.match(/^([^\w]*)(\w+)([^\w]*)$/);
    if (!m) return '';
    const v = vars[m[2]];
    return v ? `${m[1]}${v}${m[3]}` : '';
  });
  return out.replace(/\s+/g, ' ').trim();
}

export function canonicalScUrl(u) {
  try {
    const url = new URL(u, 'https://soundcloud.com');
    if (!/(^|\.)soundcloud\.com$/i.test(url.hostname)) return null;
    // No lowercasing: secret-link tokens ("/s-AbC123") are case sensitive.
    const path = url.pathname.replace(/\/+$/, '');
    return `https://soundcloud.com${path}`;
  } catch {
    return null;
  }
}
