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
 * Artist similarity. Pools often list "A, B & C feat. D" where SoundCloud shows only "A",
 * or the reverse, so we take the best of whole-string similarity and per-artist containment.
 */
export function artistSim(qArtist, cArtist, cTitle = '') {
  if (!normalizeText(qArtist) || !normalizeText(cArtist)) return normalizeText(qArtist) ? 0.3 : 0.5;
  const whole = textSim(qArtist, cArtist);
  const qNames = splitArtists(qArtist);
  const cNames = splitArtists(cArtist);
  let best = 0;
  for (const q of qNames) for (const c of cNames) best = Math.max(best, textSim(q, c));
  // The query's main artist fully contained in the candidate's credits (or title, for feats).
  const contained = containment(qNames[0] || qArtist, `${cArtist} ${cTitle}`);
  const reverse = containment(cNames[0] || cArtist, qArtist);
  return Math.max(whole, best * 0.97, contained * 0.95, reverse * 0.9);
}

const POOL_FLAVOURS = new Set(['original', 'extended', 'radio', '']);

/**
 * How compatible the candidate's version is with the one the user wants.
 * Returns { score 0..1, penalty multiplier 0..1, reason }.
 */
export function versionCompat(q, cand) {
  const qKind = classifyMix(q.mix);
  const qRemixers = q.remixers?.length ? q.remixers : extractRemixers(q.mix);
  const cMix = cand.mix || '';
  const cKind = classifyMix(cMix);
  const cRemixers = extractRemixers(cMix);
  const cText = `${cand.title} ${cMix}`;

  if (qRemixers.length) {
    const want = qRemixers.join(' ');
    const overlap = cRemixers.length ? Math.max(containment(want, cRemixers.join(' ')), containment(cRemixers.join(' '), want)) : 0;
    if (overlap >= 0.6) return { score: 1, penalty: 1, reason: 'same remixer' };
    if (containment(want, cText) >= 0.6) return { score: 0.9, penalty: 1, reason: 'remixer named in title' };
    if (cRemixers.length) return { score: 0.1, penalty: 0.45, reason: 'different remixer' };
    return { score: 0.25, penalty: 0.6, reason: 'wanted a remix, found the original' };
  }

  if (['vip', 'bootleg', 'edit', 'dub'].includes(qKind)) {
    if (cKind === qKind) return { score: 1, penalty: 1, reason: `same ${qKind}` };
    return { score: 0.5, penalty: 0.75, reason: `wanted ${qKind}, found ${cKind || 'original'}` };
  }

  if (cRemixers.length) return { score: 0.2, penalty: 0.55, reason: 'candidate is a remix' };
  if (['acapella', 'instrumental'].includes(cKind) && !['acapella', 'instrumental'].includes(qKind)) {
    return { score: 0.5, penalty: 0.8, reason: `candidate is ${cKind}` };
  }
  if (['vip', 'bootleg', 'dub', 'live'].includes(cKind)) return { score: 0.5, penalty: 0.75, reason: `candidate is ${cKind}` };
  if (POOL_FLAVOURS.has(qKind) && (POOL_FLAVOURS.has(cKind) || cKind === 'edit' || cKind === 'other')) {
    return { score: qKind === cKind || !qKind || !cKind ? 1 : 0.9, penalty: 1, reason: 'compatible version' };
  }
  return { score: 0.8, penalty: 1, reason: 'version unclear' };
}

/** Normalize a candidate row from any source into {artist,title,mix}. */
export function normalizeCandidate(c) {
  const parts = splitTitleMix(c.title || '');
  const mix = [c.version, parts.mix].filter(Boolean).join(' ').trim();
  return { artist: c.artist || '', title: parts.title || c.title || '', mix, isrc: c.isrc || '', durationSec: c.durationSec ?? null };
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
  // Some rows put the whole "Artist - Title" in the title column.
  let cand = c;
  if (!normalizeText(c.artist) && /\s[-–—]\s/.test(c.title)) {
    const [a, ...rest] = c.title.split(/\s[-–—]\s/);
    cand = { ...c, artist: a, title: rest.join(' - ') };
  }
  const title = textSim(q.title, cand.title);
  const artist = artistSim(q.artist, cand.artist, cand.title);
  const version = versionCompat(q, cand);
  let score = (0.45 * title + 0.35 * artist + 0.2 * version.score) * version.penalty;
  if (q.durationSec && cand.durationSec && Math.abs(q.durationSec - cand.durationSec) <= 3) score += 0.03;
  // A title that barely matches can't be rescued by a perfect artist match.
  if (title < 0.5) score = Math.min(score, 0.5);
  score = Math.max(0, Math.min(1, score));
  let reason = version.reason;
  if (title < 0.5) reason = 'different title';
  else if (artist < 0.5) reason = 'different artist';
  return { score: Math.round(score * 1000) / 1000, parts: { title, artist, version: version.score }, reason };
}

/**
 * Among rows that are the same song (scores within `window` of the best), put the user's
 * preferred pool version first ("Extended" before "Clean", "Acapella" last, ...).
 */
export function orderByVersionPreference(scored, { prefer = [], avoid = [] } = {}, queryMix = '', window = 0.04) {
  if (!scored.length) return scored;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top = sorted[0].score;
  const cluster = sorted.filter((s) => top - s.score <= window);
  const rest = sorted.filter((s) => top - s.score > window);
  const qm = normalizeText(queryMix);
  const rank = (s) => {
    const v = normalizeText(`${s.version || ''} ${splitTitleMix(s.title || '').mix}`);
    const avoided = avoid.some((w) => {
      const n = normalizeText(w);
      return n && v.includes(n) && !qm.includes(n);
    });
    let idx = prefer.findIndex((w) => normalizeText(w) && v.includes(normalizeText(w)));
    if (idx < 0) idx = prefer.length;
    return (avoided ? 1000 : 0) + idx;
  };
  cluster.sort((a, b) => rank(a) - rank(b) || b.score - a.score);
  return cluster.concat(rest);
}
