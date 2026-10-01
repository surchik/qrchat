import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSoundCloudTrack, splitTitleMix, classifyMix, extractRemixers, stripNoise, normalizeText,
  renderTemplate, sanitizeSegment, canonicalScUrl,
} from '../extension/src/lib/normalize.js';

const sc = (title, username = 'Some Label', extra = {}) => ({ title, user: { username }, ...extra });

test('splits "Artist - Title (Mix)" and drops promo noise', () => {
  const q = parseSoundCloudTrack(sc('PREMIERE: Ben Böhmer - Breathing (Extended Mix) [Anjunadeep]'));
  assert.equal(q.artist, 'Ben Böhmer');
  assert.equal(q.title, 'Breathing');
  assert.equal(q.mix, 'Extended Mix');
  assert.equal(q.label, 'Anjunadeep');
  assert.deepEqual(q.remixers, []);
});

test('FREE DOWNLOAD tags in every common position are removed', () => {
  for (const raw of [
    'Artist - Track [FREE DOWNLOAD]',
    'Artist - Track (FREE DL)',
    'FREE DL: Artist - Track',
    'Artist - Track **FREE DOWNLOAD**',
    '[FREE DOWNLOAD] Artist - Track',
    'Artist - Track | FREE DL',
  ]) {
    const q = parseSoundCloudTrack(sc(raw));
    assert.equal(q.artist, 'Artist', raw);
    assert.equal(q.title, 'Track', raw);
    assert.equal(q.mix, '', raw);
  }
});

test('remixers are extracted, generic mix words are not', () => {
  assert.deepEqual(extractRemixers('Fred again.. & Skrillex Remix'), ['Fred again..', 'Skrillex']);
  assert.deepEqual(extractRemixers('Extended Mix'), []);
  assert.deepEqual(extractRemixers('Radio Edit'), []);
  assert.deepEqual(extractRemixers("Mau P's VIP"), ['Mau P']);
  const q = parseSoundCloudTrack(sc('Disclosure - Latch (Kaytranada Remix)'));
  assert.deepEqual(q.remixers, ['Kaytranada']);
});

test('featured artists are pulled out of title and artist', () => {
  const q = parseSoundCloudTrack(sc('Calvin Harris feat. Rihanna - This Is What You Came For (Extended Mix)'));
  assert.equal(q.artist, 'Calvin Harris');
  assert.deepEqual(q.featuring, ['Rihanna']);
  assert.equal(q.title, 'This Is What You Came For');
  const q2 = parseSoundCloudTrack(sc('Artist - Song (ft. Singer)'));
  assert.equal(q2.title, 'Song');
  assert.deepEqual(q2.featuring, ['Singer']);
});

test('falls back to publisher artist, then uploader, when there is no dash', () => {
  assert.equal(parseSoundCloudTrack(sc('Just A Title', 'DJ Uploader')).artist, 'DJ Uploader');
  assert.equal(parseSoundCloudTrack(sc('Just A Title', 'Label', { publisher_metadata: { artist: 'Real Artist' } })).artist, 'Real Artist');
});

test('duration, isrc and genre are carried over', () => {
  const q = parseSoundCloudTrack(sc('A - B', 'x', { full_duration: 361234, genre: 'Tech House', publisher_metadata: { isrc: 'gbabc2400001' } }));
  assert.equal(q.durationSec, 361);
  assert.equal(q.isrc, 'GBABC2400001');
  assert.equal(q.genre, 'Tech House');
});

test('splitTitleMix handles store-style " - Extended Mix" suffixes', () => {
  assert.deepEqual(splitTitleMix('Strobe - Extended Mix'), { title: 'Strobe', mix: 'Extended Mix', featuring: [], label: '' });
});

test('classifyMix', () => {
  assert.equal(classifyMix(''), '');
  assert.equal(classifyMix('Extended Mix'), 'extended');
  assert.equal(classifyMix('Original Mix'), 'original');
  assert.equal(classifyMix('Kaytranada Remix'), 'remix');
  assert.equal(classifyMix('Intro - Dirty'), 'original');
  assert.equal(classifyMix('Acapella'), 'acapella');
  assert.equal(classifyMix('VIP'), 'vip');
  assert.equal(classifyMix('Bootleg'), 'bootleg');
});

test('stripNoise removes hashtags and emoji', () => {
  assert.equal(stripNoise('🔥 Artist - Track #techno #free'), 'Artist - Track');
});

test('normalizeText keeps non-Latin scripts and strips accents', () => {
  assert.equal(normalizeText('Röyksopp & Robyn'), 'royksopp and robyn');
  assert.equal(normalizeText('Кино — Группа крови'), 'кино группа крови');
});

test('renderTemplate collapses empty optional parts', () => {
  assert.equal(renderTemplate('{artist} - {title}{ (mix)}', { artist: 'A', title: 'B', mix: '' }), 'A - B');
  assert.equal(renderTemplate('{artist} - {title}{ (mix)}', { artist: 'A', title: 'B', mix: 'Dub' }), 'A - B (Dub)');
  assert.equal(renderTemplate('DJ/{source}/{date}', { source: 'Bandcamp', date: '2026-10' }), 'DJ/Bandcamp/2026-10');
});

test('sanitizeSegment makes cross-platform-safe names', () => {
  assert.equal(sanitizeSegment('AC/DC: "Back" <In> Black?'), 'AC DC Back In Black');
  assert.equal(sanitizeSegment('con'), '_con');
  assert.equal(sanitizeSegment('...hidden. '), 'hidden');
});

test('canonicalScUrl strips query/hash/trailing slash and keeps secret token case', () => {
  assert.equal(canonicalScUrl('https://soundcloud.com/artist/track/?in=x#t=1'), 'https://soundcloud.com/artist/track');
  assert.equal(canonicalScUrl('https://soundcloud.com/a/b/s-AbC123'), 'https://soundcloud.com/a/b/s-AbC123');
  assert.equal(canonicalScUrl('https://example.com/a/b'), null);
});
