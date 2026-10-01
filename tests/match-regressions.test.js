// Regression cases found by adversarial review: realistic SoundCloud titles vs pool rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, orderByVersionPreference } from '../extension/src/lib/match.js';
import { parseSoundCloudTrack } from '../extension/src/lib/normalize.js';

const AUTO = 0.82;
const REVIEW = 0.55;
const q = (title, username = 'Some Label', extra = {}) => parseSoundCloudTrack({ title, user: { username }, ...extra });
const row = (artist, title, version = '', extra = {}) => ({ artist, title, version, ...extra });

// [query title, uploader, wrong candidate]
const MUST_NOT_AUTO = [
  ['Dom Dolla - Saving Up (Remix) | Free Download', 'Some DJ', row('Dom Dolla', 'Saving Up', 'Extended Mix')],
  ['Eric Prydz - Opus (Live at Tomorrowland)', 'x', row('Eric Prydz', 'Opus', 'Extended Mix')],
  ['Daft Punk - One More Time (Kid Cover)', 'x', row('Daft Punk', 'One More Time', 'Extended Mix')],
  ['Daft Punk - One More Time (Kid Redrum)', 'x', row('Daft Punk', 'One More Time', 'Extended Mix')],
  ['Joy Orbison - flight fm', 'x', row('Joy Orbison', 'flight fm', 'Remix')],
  ['Bob Sinclar - Love Generation', 'x', row('Bob Sinclar', 'Love Generation (Remix)')],
  ['Eric Prydz - Opus (Extended Mix)', 'x', row('Eric Prydz', 'Opus', 'Remix')],
  ['Calvin Harris & Dua Lipa - One Kiss (Jack Back Remix)', 'x', row('Calvin Harris, Dua Lipa', 'One Kiss', 'Jack Back Dub')],
  ['Calvin Harris, Dua Lipa - One Kiss (Jack Back Dub)', 'x', row('Calvin Harris, Dua Lipa', 'One Kiss', 'Jack Back Remix')],
  ['Bonobo - Kerala (Dixon Remix)', 'x', row('Bonobo', 'Kerala', 'Dixon Edit')],
  ['Bonobo - Kerala (Dixon Edit)', 'x', row('Bonobo', 'Kerala', 'Dixon Remix')],
  ['Eric Prydz - Opus (Four Tet Remix)', 'x', row('Eric Prydz', 'Opus (Four Tet Remix) [Acapella]')],
  ['Eric Prydz - Opus (Four Tet Remix)', 'x', row('Eric Prydz', 'Opus', 'Four Tet Remix Instrumental')],
  ['Eric Prydz - Opus (Dub)', 'x', row('Eric Prydz', 'Opus', 'Four Tet Dub')],
  ['Patrick Topping - Be Sharp Say Nowt (Original Mix)', 'x', row('Patrick Topping', 'Be Sharp Say Nowt', 'Radio Edit')],
  ['Dom Dolla - Saving Up (Extended Mix)', 'x', row('Dom Dolla', 'Saving Up', 'Radio Edit')],
  ['Bicep - Glue', 'x', row('Bicep', 'Glue', 'Special Mix')],
  ['Daft Punk - One More Time', 'x', row('Daft Punk', 'One More Time (Piano Cover)')],
  ['Daft Punk - One More Time', 'x', row('Daft Punk', 'One More Time (Sped Up)')],
  ['Daft Punk - One More Time (Sped Up)', 'x', row('Daft Punk', 'One More Time', 'Extended Mix')],
  ['Bicep - Glue', 'x', row('Bicep', 'Glue 2')],
  ['Alok - Hear Me Now', 'x', row('Alok', 'Hear Me Now 2')],
  ['Fatboy Slim - Praise You', 'x', row('Fatboy Slim', 'Praise You 2024')],
  ['Eric Prydz - Opus', 'x', row('Eric', 'Opus')],
  ['Chase & Status - Baddadan', 'x', row('Chase Atlantic', 'Baddadan')],
  ['Simon & Garfunkel - The Boxer', 'x', row('Paul Simon', 'The Boxer')],
  ['Daft Punk - One More Time', 'x', row('Daft Punk Tribute Band', 'One More Time')],
  ['DJ Snake - Turn Down for What', 'x', row('DJ Khaled', 'Turn Down for What')],
  ['Track', '', row('Anyone', 'Track')],
  ['Dom Dolla - Saving Up', 'x', row('Dom Dolla', 'Saving Up', 'Acapella')],
  ['Dom Dolla - Saving Up (Clean)', 'x', row('Dom Dolla', 'Saving Up', 'Dirty')],
];

for (const [title, user, cand] of MUST_NOT_AUTO) {
  test(`no auto-download: "${title}" vs ${JSON.stringify(cand)}`, () => {
    const s = scoreCandidate(q(title, user), cand);
    assert.ok(s.score < AUTO, JSON.stringify(s));
  });
}

// [query title, uploader, right candidate] that must at least be offered for review
const MUST_REVIEW = [
  ['Eric Prydz - Opus (Eric Prydz VIP)', 'x', row('Eric Prydz', 'Opus', 'VIP')],
  ['Skream - Midnight Request Line (Skream VIP)', 'x', row('Skream', 'Midnight Request Line', 'VIP')],
  ['Peggy Gou - (It Goes Like) Nanana', 'x', row('Peggy Gou', 'Nanana', 'Extended Mix')],
  ['Four Tet - Baby (Ellie Goulding)', 'x', row('Four Tet', 'Baby')],
  ['FISHER "LOSING IT"', 'Catch & Release', row('FISHER', 'Losing It')],
  ['Eric Prydz - Opus (Four Tet Remix)', 'x', row('Pryda Recordings', 'Eric Prydz - Opus (Four Tet Remix)')],
];
for (const [title, user, cand] of MUST_REVIEW) {
  test(`offered for review: "${title}" vs ${JSON.stringify(cand)}`, () => {
    const s = scoreCandidate(q(title, user), cand);
    assert.ok(s.score >= REVIEW, JSON.stringify(s));
  });
}

// Still confident where it should be.
const MUST_AUTO = [
  ['Ben Böhmer - Breathing (Extended Mix)', 'x', row('Ben Bohmer', 'Breathing', 'Extended Mix')],
  ['Chris Lake - Turn Off The Lights (Extended)', 'x', row('Chris Lake, Alexis Roberts', 'Turn Off The Lights', 'Extended Mix')],
  ['Calvin Harris & Dua Lipa - One Kiss (Jack Back Remix)', 'x', row('Calvin Harris, Dua Lipa', 'One Kiss', 'Jack Back Remix')],
  ['Calvin Harris & Dua Lipa - One Kiss', 'x', row('Calvin Harris', 'One Kiss', 'Extended Mix')],
  ['Disclosure - Latch (Kaytranada Remix)', 'x', row('Disclosure', 'Latch', 'Kaytranada Remix')],
  ['01. Dom Dolla - Saving Up', 'x', row('Dom Dolla', 'Saving Up', 'Extended Mix')],
  ['🚨FREE DL🚨 Dom Dolla - Saving Up', 'x', row('Dom Dolla', 'Saving Up', 'Intro Dirty')],
  ['FISHER "LOSING IT"', 'FISHER', row('FISHER', 'Losing It', 'Extended Mix')],
  ['Eric Prydz - Opus (Four Tet Remix)', 'x', row('Eric Prydz', 'Opus', 'Four Tet Remix')],
  ['Dom Dolla - Saving Up', 'x', row('Defected Records', 'Dom Dolla - Saving Up')],
];
for (const [title, user, cand] of MUST_AUTO) {
  test(`still auto: "${title}" vs ${JSON.stringify(cand)}`, () => {
    const s = scoreCandidate(q(title, user), cand);
    assert.ok(s.score >= AUTO, JSON.stringify(s));
  });
}

test('parse fixes', () => {
  assert.equal(q('01. Dom Dolla - Saving Up').artist, 'Dom Dolla');
  assert.equal(q('🚨FREE DL🚨 Dom Dolla - Saving Up (Kid Edit)').artist, 'Dom Dolla');
  const fisher = q('FISHER "LOSING IT"', 'Catch & Release');
  assert.equal(fisher.artist, 'FISHER');
  assert.equal(fisher.title, 'LOSING IT');
  assert.equal(q('Eric Prydz - Opus (Extended Mix) // FREE DL').title, 'Opus');
  assert.deepEqual(q('Fatboy Slim - Praise You (2024 Remix)').remixers, []);
});

test('explicitly requested version beats the preference order', () => {
  const versions = ['Extended Mix', 'Original Mix', 'Radio Edit', 'Intro Dirty', 'Dirty', 'Intro Clean', 'Clean'];
  const prefer = ['Extended', 'Original', 'Intro Dirty', 'Dirty', 'Main', 'Intro Clean', 'Clean', 'Radio'];
  const pick = (title) => {
    const query = q(title);
    const scored = versions.map((v) => ({ ...row('Eric Prydz', 'Opus', v), ...scoreCandidate(query, row('Eric Prydz', 'Opus', v)) }));
    return orderByVersionPreference(scored, { prefer }, query.mix)[0].version;
  };
  assert.equal(pick('Eric Prydz - Opus (Radio Edit)'), 'Radio Edit');
  assert.equal(pick('Eric Prydz - Opus (Clean)'), 'Clean');
  assert.equal(pick('Eric Prydz - Opus (Original Mix)'), 'Original Mix');
  assert.equal(pick('Eric Prydz - Opus'), 'Extended Mix');
});
