import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, orderByVersionPreference, artistSim, textSim } from '../extension/src/lib/match.js';
import { parseSoundCloudTrack } from '../extension/src/lib/normalize.js';

const AUTO = 0.82;
const REVIEW = 0.55;
const q = (title, username = 'Label') => parseSoundCloudTrack({ title, user: { username } });

test('exact pool row scores above the auto threshold', () => {
  const s = scoreCandidate(q('Ben Böhmer - Breathing (Extended Mix)'), { artist: 'Ben Bohmer', title: 'Breathing', version: 'Extended Mix' });
  assert.ok(s.score >= AUTO, JSON.stringify(s));
});

test('pool flavours (Intro Dirty / Clean) of the original are still confident matches', () => {
  const query = q('Dom Dolla - Saving Up');
  for (const version of ['Intro Dirty', 'Clean', 'Extended Mix', 'Original Mix', '']) {
    const s = scoreCandidate(query, { artist: 'Dom Dolla', title: 'Saving Up', version });
    assert.ok(s.score >= AUTO, `${version}: ${JSON.stringify(s)}`);
  }
});

test('a different remix of the same song never auto-matches', () => {
  const query = q('Disclosure - Latch (Kaytranada Remix)');
  const wrong = scoreCandidate(query, { artist: 'Disclosure feat. Sam Smith', title: 'Latch', version: 'Hot Since 82 Remix' });
  const original = scoreCandidate(query, { artist: 'Disclosure', title: 'Latch', version: 'Extended Mix' });
  const right = scoreCandidate(query, { artist: 'Disclosure', title: 'Latch', version: 'Kaytranada Remix' });
  assert.ok(wrong.score < REVIEW, JSON.stringify(wrong));
  assert.ok(original.score < AUTO, JSON.stringify(original));
  assert.ok(right.score >= AUTO, JSON.stringify(right));
});

test('a remix candidate for an original query does not auto-match', () => {
  const s = scoreCandidate(q('Disclosure - Latch'), { artist: 'Disclosure', title: 'Latch', version: 'Kaytranada Remix' });
  assert.ok(s.score < AUTO, JSON.stringify(s));
});

test('wrong song by the same artist is rejected', () => {
  const s = scoreCandidate(q('Fred again.. - Delilah (pull me out of this)'), { artist: 'Fred again..', title: 'Jungle' });
  assert.ok(s.score < REVIEW, JSON.stringify(s));
});

test('same title by a different artist is not confident', () => {
  const s = scoreCandidate(q('CamelPhat - Breathe'), { artist: 'The Prodigy', title: 'Breathe' });
  assert.ok(s.score < AUTO, JSON.stringify(s));
});

test('multi-artist credits on the pool still match the SoundCloud main artist', () => {
  const s = scoreCandidate(q('Chris Lake - Turn Off The Lights (Extended)'), { artist: 'Chris Lake, Alexis Roberts', title: 'Turn Off The Lights', version: 'Extended Mix' });
  assert.ok(s.score >= AUTO, JSON.stringify(s));
});

test('rows that put "Artist - Title" in the title column are handled', () => {
  const s = scoreCandidate(q('Mau P - Drugs From Amsterdam'), { artist: '', title: 'Mau P - Drugs From Amsterdam (Extended Mix)' });
  assert.ok(s.score >= AUTO, JSON.stringify(s));
});

test('acapella/instrumental rows rank as review-only for a normal query', () => {
  const s = scoreCandidate(q('Dom Dolla - Saving Up'), { artist: 'Dom Dolla', title: 'Saving Up', version: 'Acapella' });
  assert.ok(s.score < AUTO && s.score >= REVIEW, JSON.stringify(s));
});

test('ISRC equality wins outright', () => {
  const s = scoreCandidate({ artist: 'x', title: 'y', mix: '', isrc: 'GBABC2400001' }, { artist: 'other', title: 'thing', isrc: 'gbabc2400001' });
  assert.equal(s.score, 0.99);
});

test('version preference orders same-song rows, avoids acapella', () => {
  const query = q('Dom Dolla - Saving Up');
  const rows = ['Acapella', 'Clean', 'Intro Dirty', 'Extended Mix'].map((version) => ({ artist: 'Dom Dolla', title: 'Saving Up', version }));
  const scored = rows.map((r) => ({ ...r, ...scoreCandidate(query, r) }));
  const ordered = orderByVersionPreference(scored, { prefer: ['Extended', 'Intro Dirty', 'Clean'], avoid: ['Acapella'] }, query.mix, 0.2);
  assert.deepEqual(ordered.map((r) => r.version), ['Extended Mix', 'Intro Dirty', 'Clean', 'Acapella']);
});

test('similarity helpers behave sensibly', () => {
  assert.equal(textSim('Breathing', 'breathing'), 1);
  assert.ok(textSim('Fred Again', 'Fred again..') > 0.9);
  assert.ok(artistSim('Bicep', 'Bicep, Clara La San') > 0.9);
  assert.ok(artistSim('Bicep', 'Bonobo') < 0.5);
});
