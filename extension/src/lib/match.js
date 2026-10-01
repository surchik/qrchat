// Fuzzy matching between a SoundCloud query and candidate rows from pools/stores.
// Pure functions; unit tested in tests/match.test.js.

import {
  normalizeText, tokens, splitArtists, splitTitleMix, classifyMix, extractRemixers,
} from './normalize.js';

export function setDice(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

function bigrams(s) {
  const t = normalizeText(s).replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

/** Multiset Dice on character bigrams; tolerant of typos and spacing ("Fred Again" vs "Fred again.."). */
export function bigramDice(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length && !B.length) return normalizeText(a) === normalizeText(b) ? 1 : 0;
  if (!A.length || !B.length) return 0;
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let inter = 0;
  for (const g of B) {
    const c = counts.get(g);
    if (c) {
      inter += 1;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}

export function textSim(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return 0.6 * setDice(tokens(a), tokens(b)) + 0.4 * bigramDice(a, b);
}

/** Share of `needle` tokens present in `hay` tokens. */
export function containment(needle, hay) {
  const N = tokens(needle);
  if (!N.length) return 0;
  const H = new Set(tokens(hay));
  return N.filter((t) => H.has(t)).length / N.length;
}

/**
 * Artist similarity. Pools often list "A, B & C feat. D" where SoundCloud shows only "A", or the
 * reverse. A name only counts as matched when the whole name matches (so "Eric" is not
 * "Eric Prydz" and "Chase Atlantic" is not "Chase & Status").
 */
export function artistSim(qArtist, cArtist, cTitle = '') {
  if (!normalizeText(qArtist)) return 0.4; // unknown artist: never enough for an auto match
  if (!normalizeText(cArtist)) return 0.3;
  const whole = textSim(qArtist, cArtist);
  const qNames = splitArtists(qArtist);
  const cNames = splitArtists(cArtist);
  const named = (a, list) => list.some((b) => textSim(a, b) >= 0.85);
  const qCovered = qNames.filter((n) => named(n, cNames) || containment(n, cTitle) === 1).length / (qNames.length || 1);
  const cCovered = cNames.filter((n) => named(n, qNames)).length / (cNames.length || 1);
  // The query's main artist credited alongside others (or as a feat. in the title).
  const mainCredited = qNames.length && (named(qNames[0], cNames) || containment(qNames[0], cTitle) === 1);
  return Math.max(whole, 0.97 * qCovered, mainCredited ? 0.9 : 0, cCovered === 1 ? 0.85 : 0);
}

/** "clean" / "dirty" pool flavour named in a mix, or ''. */
export function flavourOf(text) {
  const t = normalizeText(text);
  if (/\bclean\b/.test(t)) return 'clean';
  if (/\b(dirty|explicit)\b/.test(t)) return 'dirty';
  return '';
}

const PLAIN = new Set(['', 'original', 'extended', 'radio']);
const SPECIAL = new Set(['acapella', 'instrumental']);

function remixersExcluding(mix, artist) {
  const main = splitArtists(artist).map(normalizeText);
  return extractRemixers(mix).filter((r) => !main.includes(normalizeText(r)) && !/^\d+$/.test(normalizeText(r)));
}

/**
 * How compatible the candidate's version is with the one the user wants.
 * Returns { score 0..1, penalty multiplier 0..1, reason }.
 */
export function versionCompat(q, cand) {
  const qKind = classifyMix(q.mix);
  const qRemixers = remixersExcluding(q.mix, q.artist);
  const cMix = cand.mix || '';
  const cKind = classifyMix(cMix);
  const cRemixers = remixersExcluding(cMix, cand.artist || q.artist);
  const cText = `${cand.title} ${cMix}`;
  const qFlav = flavourOf(q.mix);
  const cFlav = flavourOf(cMix);

  // An acapella / instrumental is never a substitute for the full track (and vice versa).
  if (SPECIAL.has(cKind) !== SPECIAL.has(qKind) || (SPECIAL.has(cKind) && cKind !== qKind)) {
    return { score: 0.4, penalty: 0.7, reason: `candidate is ${cKind || 'the full track'}` };
  }
  if (qFlav && cFlav && qFlav !== cFlav) return { score: 0.5, penalty: 0.8, reason: `wanted ${qFlav}, found ${cFlav}` };

  if (qRemixers.length) {
    const want = qRemixers.join(' ');
    const overlap = cRemixers.length ? Math.max(containment(want, cRemixers.join(' ')), containment(cRemixers.join(' '), want)) : 0;
    const named = overlap >= 0.6 || containment(want, cText) >= 0.6;
    if (named) {
      // Same remixer, but a Dub / Edit is not the Remix you asked for.
      const sameKind = cKind === qKind || (PLAIN.has(cKind) && qKind === 'remix');
      if (sameKind) return { score: overlap >= 0.6 ? 1 : 0.9, penalty: 1, reason: 'same remixer' };
      return { score: 0.6, penalty: 0.8, reason: `same remixer, but ${cKind || 'original'} instead of ${qKind}` };
    }
    if (cRemixers.length) return { score: 0.1, penalty: 0.45, reason: 'different remixer' };
    // Offered for review (you may take the original), never auto-picked.
    return { score: 0.3, penalty: 0.66, reason: 'wanted a remix, found the original' };
  }

  // Specific kinds without a name: "(Remix)", "(VIP)", "(Live …)", "(Cover)", "(Dub)", "(Edit)".
  if (!PLAIN.has(qKind)) {
    if (cKind === qKind && !cRemixers.length) return { score: 1, penalty: 1, reason: `same ${qKind}` };
    return { score: 0.5, penalty: 0.75, reason: `wanted ${qKind}, found ${cKind || 'original'}` };
  }

  // The user wants the original (any plain flavour).
  if (cRemixers.length || cKind === 'remix') return { score: 0.2, penalty: 0.55, reason: 'candidate is a remix' };
  if (['vip', 'bootleg', 'dub', 'live', 'cover'].includes(cKind)) return { score: 0.5, penalty: 0.75, reason: `candidate is ${cKind}` };
  if (cKind === 'other') return { score: 0.6, penalty: 0.85, reason: `candidate is “${cMix}”` };
  // Explicit Extended/Original asked for, but this is an edit (radio or otherwise).
  if ((qKind === 'extended' || qKind === 'original') && (cKind === 'radio' || cKind === 'edit')) {
    return { score: 0.6, penalty: 0.85, reason: `wanted ${qKind}, found ${cKind}` };
  }
  return { score: qKind === cKind || !qKind || !cKind ? 1 : 0.9, penalty: 1, reason: 'compatible version' };
}

/** Normalize a candidate row from any source into {artist,title,mix}. */
export function normalizeCandidate(c) {
  const parts = splitTitleMix(c.title || '');
  const mix = [c.version, parts.mix].filter(Boolean).join(' ').trim();
  return { artist: c.artist || '', title: parts.title || c.title || '', mix, isrc: c.isrc || '', durationSec: c.durationSec ?? null };
}

const stripParens = (t) => String(t || '').replace(/[([][^()[\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim();

/** Best title similarity over parenthesis-free variants ("(It Goes Like) Nanana" vs "Nanana"). */
function titleSim(qTitle, cTitle) {
  let best = textSim(qTitle, cTitle);
  const qa = stripParens(qTitle);
  const ca = stripParens(cTitle);
  if (qa && qa !== qTitle) best = Math.max(best, 0.97 * textSim(qa, cTitle));
  if (ca && ca !== cTitle) best = Math.max(best, 0.97 * textSim(qTitle, ca));
  return best;
}

function scoreOne(q, cand) {
  const title = titleSim(q.title, cand.title);
  const artist = artistSim(q.artist, cand.artist, cand.title);
  const version = versionCompat(q, cand);
  let score = (0.45 * title + 0.35 * artist + 0.2 * version.score) * version.penalty;
  if (q.durationSec && cand.durationSec && title >= 0.8 && artist >= 0.8 && Math.abs(q.durationSec - cand.durationSec) <= 3) score += 0.03;
  // Guards: a weak title or artist can't be rescued by the other parts.
  if (title < 0.5) score = Math.min(score, 0.5);
  if (artist < 0.7) score = Math.min(score, 0.75);
  // "Glue" vs "Glue 2", "Praise You" vs "Praise You 2024": different words, different song.
  const qt = new Set(tokens(stripParens(q.title) || q.title));
  const ct = new Set(tokens(stripParens(cand.title) || cand.title));
  const extra = [...qt].filter((t) => !ct.has(t)).length + [...ct].filter((t) => !qt.has(t)).length;
  if (extra && title < 0.97) score = Math.min(score, 0.8);
  score = Math.max(0, Math.min(1, score));
  let reason = version.reason;
  if (title < 0.5) reason = 'different title';
  else if (artist < 0.7) reason = 'different artist';
  else if (extra && title < 0.97) reason = 'title differs';
  return { score: Math.round(score * 1000) / 1000, parts: { title, artist, version: version.score }, reason };
}

/**
 * Score a candidate against the query.
 * @param {{artist:string,title:string,mix:string,remixers?:string[],isrc?:string,durationSec?:number|null}} q
 * @param {{artist?:string,title?:string,version?:string,isrc?:string,durationSec?:number|null}} rawCand
 */
export function scoreCandidate(q, rawCand) {
  const c = normalizeCandidate(rawCand);
  if (q.isrc && c.isrc && q.isrc.toUpperCase() === c.isrc.toUpperCase()) {
    return { score: 0.99, parts: { isrc: 1 }, reason: 'ISRC match' };
  }
  const variants = [c];
  // Rows that put "Artist - Title" in the title column (with or without a label as artist).
  if (/\s[-–—]\s/.test(c.title)) {
    const [a, ...rest] = c.title.split(/\s[-–—]\s/);
    variants.push({ ...c, artist: a, title: rest.join(' - ') });
  }
  return variants.map((v) => scoreOne(q, v)).sort((x, y) => y.score - x.score)[0];
}

/**
 * Among rows that are the same song (scores within `window` of the best), put the version the
 * user asked for first, then their preferred pool version ("Extended" before "Clean",
 * "Acapella" last, ...).
 */
export function orderByVersionPreference(scored, { prefer = [], avoid = [] } = {}, queryMix = '', window = 0.04) {
  if (!scored.length) return scored;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top = sorted[0].score;
  const cluster = sorted.filter((s) => top - s.score <= window);
  const rest = sorted.filter((s) => top - s.score > window);
  const qm = normalizeText(queryMix);
  const qKind = classifyMix(queryMix);
  const qFlav = flavourOf(queryMix);
  const rank = (s) => {
    const mixText = `${s.version || ''} ${splitTitleMix(s.title || '').mix}`;
    const v = normalizeText(mixText);
    // Explicitly requested version wins: exact text, else same kind and flavour.
    let exact = 2;
    if (qm && v === qm) exact = 0;
    else if (qm && classifyMix(mixText) === qKind && flavourOf(mixText) === qFlav) exact = 1;
    const avoided = avoid.some((w) => {
      const n = normalizeText(w);
      return n && v.includes(n) && !qm.includes(n);
    });
    let idx = prefer.findIndex((w) => normalizeText(w) && v.includes(normalizeText(w)));
    if (idx < 0) idx = prefer.length;
    return (avoided ? 10000 : 0) + exact * 100 + idx;
  };
  cluster.sort((a, b) => rank(a) - rank(b) || b.score - a.score);
  return cluster.concat(rest);
}
