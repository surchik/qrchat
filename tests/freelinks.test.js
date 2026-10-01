import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTrackLinks, isActionableFreeLink, classifyHost } from '../extension/src/lib/freelinks.js';
import { DEFAULTS } from '../extension/src/lib/settings.js';

const D = DEFAULTS.freeDomains;

test('buy link to a gate labelled FREE DOWNLOAD is actionable', () => {
  const links = findTrackLinks({ purchase_url: 'https://hypeddit.com/artist/track', purchase_title: 'FREE DOWNLOAD' }, D);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'gate');
  assert.equal(links[0].labelledFree, true);
  assert.ok(isActionableFreeLink(links[0]));
});

test('description links are classified; paid stores are not actionable', () => {
  const description = [
    'Out now on Defected!',
    'Buy: https://www.beatport.com/track/x/123',
    'Free download → https://www.dropbox.com/s/abc/track.wav?dl=0.',
    'More: hypeddit.com/artist/othertrack',
    'Bandcamp https://artist.bandcamp.com/track/thing',
    'Follow https://instagram.com/artist',
  ].join('\n');
  const links = findTrackLinks({ description }, D);
  const byHost = Object.fromEntries(links.map((l) => [l.host, l]));
  assert.equal(byHost['beatport.com'].kind, 'paidstore');
  assert.equal(isActionableFreeLink(byHost['beatport.com']), false);
  assert.equal(byHost['dropbox.com'].kind, 'filehost');
  assert.equal(byHost['dropbox.com'].url, 'https://www.dropbox.com/s/abc/track.wav?dl=0');
  assert.equal(byHost['dropbox.com'].labelledFree, true);
  assert.equal(byHost['hypeddit.com'].kind, 'gate');
  assert.equal(byHost['artist.bandcamp.com'].kind, 'bandcamp');
  assert.equal(byHost['instagram.com'].kind, 'other');
  assert.equal(isActionableFreeLink(byHost['instagram.com']), false);
});

test('soundcloud links are ignored and duplicates collapsed', () => {
  const links = findTrackLinks({
    purchase_url: 'https://hypeddit.com/a/b',
    description: 'https://hypeddit.com/a/b https://soundcloud.com/x/y',
  }, D);
  assert.equal(links.length, 1);
});

test('link hubs need a "free" label to be opened', () => {
  const [plain] = findTrackLinks({ description: 'Stream: https://lnk.to/abc' }, D);
  const [free] = findTrackLinks({ description: 'FREE DL: https://lnk.to/xyz' }, D);
  assert.equal(isActionableFreeLink(plain), false);
  assert.equal(isActionableFreeLink(free), true);
});

test('subdomains match their parent domain', () => {
  assert.equal(classifyHost('dl.dropbox.com', D), 'filehost');
  assert.equal(classifyHost('notdropbox.com', D), '');
});
