// Robustness suite: the edges that break in real use.
//  - JSON pool API whose download endpoint returns a signed URL
//  - logged-out pool (redirect to /login) is reported, the hunt falls through
//  - daily download cap is enforced
//  - unsure match -> review card -> pick a candidate in the toast -> download
//  - artist-enabled SoundCloud download (original file)
//  - an unrelated download while a gate is pending is NOT hijacked or renamed
//  - double-clicking a button starts one hunt, not two
//  - pasting a non-SoundCloud link in the popup shows an error
//  - the service worker is killed while a gate is open; the gate's file is still captured

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setup, waitFor, sleep, audio, html } from './harness.mjs';

const track = (id, user, slug, title, extra = {}) => ({
  kind: 'track', id, title, user: { username: user },
  permalink_url: `https://soundcloud.com/${user.toLowerCase().replace(/\s+/g, '')}/${slug}`,
  downloadable: false, description: '', ...extra,
});

let POOL_ORIGIN = '';
const poolState = { loggedIn: true };

const JSON1 = track(101, 'Json Artist', 'json-track', 'Json Artist - Json Track (Extended Mix)');
const LOGGEDOUT = track(102, 'Lo Artist', 'logged-out', 'Lo Artist - Behind The Login');
const CAPPED = track(103, 'Cap Artist', 'capped', 'Cap Artist - Over The Cap');
const REVIEW = track(104, 'Rev Artist', 'review-me', 'Rev Artist - Pick Me (Mystery Remix)');
const ORIGINAL = track(105, 'Orig Artist', 'original', 'Orig Artist - Straight From SC', { downloadable: true, has_downloads_left: true });
const GATED = track(106, 'Gate Artist', 'pending-gate', 'Gate Artist - Pending Gate', { purchase_url: 'https://hypeddit.com/gate/pending', purchase_title: 'FREE DOWNLOAD' });
const DOUBLE = track(107, 'Dbl Artist', 'double', 'Dbl Artist - Double Click');
const SWKILL = track(108, 'Kill Artist', 'sw-killed', 'Kill Artist - Survives Restart', { purchase_url: 'https://hypeddit.com/gate/survive', purchase_title: 'FREE DOWNLOAD' });
const ALL = [JSON1, LOGGEDOUT, CAPPED, REVIEW, ORIGINAL, GATED, DOUBLE, SWKILL];
const TRACKS = Object.fromEntries(ALL.map((t) => [t.permalink_url, t]));

const POOL_ROWS = [
  { id: 1, title: 'Json Track', artists: [{ name: 'Json Artist' }], version: 'Extended Mix' },
  { id: 2, title: 'Json Track', artists: [{ name: 'Json Artist' }], version: 'Acapella' },
  { id: 3, title: 'Over The Cap', artists: [{ name: 'Cap Artist' }], version: 'Original Mix' },
  { id: 4, title: 'Pick Me', artists: [{ name: 'Rev Artist' }], version: 'Other Person Remix' },
  { id: 5, title: 'Pick Me', artists: [{ name: 'Rev Artist' }], version: 'Original Mix' },
  { id: 6, title: 'Double Click', artists: [{ name: 'Dbl Artist' }], version: 'Extended Mix' },
];

const SC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>SoundCloud mock</title></head><body><main><ul>
  ${ALL.map((t) => `<li class="soundList__item"><a class="soundTitle__title" href="${new URL(t.permalink_url).pathname}">${t.title}</a>
  <div class="soundActions"><div class="sc-button-group"><button>Like</button></div></div></li>`).join('\n')}
</ul></main></body></html>`;
const QUIET_GATE = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Gate</h1><a id="dl" href="/files/gatefile.wav">Download</a></body></html>`;

const h = await setup({
  hosts: ['soundcloud.com', 'hypeddit.com'],
  tracks: TRACKS,
  settings: (pool) => {
    POOL_ORIGIN = pool;
    return {
      sources: { 'sc-alt': { enabled: false }, bandcamp: { enabled: false } },
      gates: { mode: 'guide', closeAfterCapture: false },
      wantlist: { enabled: true },
      djdelivery: {
        baseUrl: pool,
        searchUrl: `${pool}/api/search?q={query}`,
        transport: 'background',
        format: 'json',
        minIntervalMs: 50,
        loginUrlIncludes: '/login',
        json: { itemsPath: 'data.results', title: 'title', artist: 'artists', version: 'version', id: 'id' },
        download: { urlTemplate: `${pool}/api/download/{id}`, method: 'GET', resolveJsonPath: 'link.href' },
        dailyDownloadCap: 3,
      },
    };
  },
  pool(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/login') return html(res, '<form action="/login"><input type="password"></form>'), true;
    if (url.pathname === '/api/search') {
      if (!poolState.loggedIn) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return true;
      }
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const results = POOL_ROWS.filter((r) => q.includes(r.title.toLowerCase()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { total: results.length, results } }));
      return true;
    }
    const dl = url.pathname.match(/^\/api\/download\/(\d+)$/);
    if (dl) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ link: { href: `/files/pool_${dl[1]}.wav?sig=abc` } }));
      return true;
    }
    const f = url.pathname.match(/^\/files\/([\w.-]+)$/);
    if (f) return audio(res, f[1]), true;
    return false;
  },
  https(host, path, req, res) {
    const url = new URL(path, `https://${host}`);
    if (host === 'soundcloud.com') return html(res, SC_PAGE), true;
    if (host === 'hypeddit.com') {
      const f = url.pathname.match(/^\/files\/([\w.-]+)$/);
      if (f) return audio(res, `gate_${f[1]}`), true;
      return html(res, QUIET_GATE), true;
    }
    return false;
  },
});

// SoundCloud's original-file endpoint points at the mock pool's file server.
ORIGINAL.__download = `${POOL_ORIGIN}/files/sc_original.wav`;
await h.swEval(() => {
  self.__stubbed = false;
});
await h.stub();
await h.swEval((t) => {
  // Patch the stubbed /download answer for ORIGINAL (installed before POOL_ORIGIN was known).
  const prev = self.fetch;
  self.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.host === 'api-v2.soundcloud.com' && u.pathname === `/tracks/${t.id}/download`) {
      return new Response(JSON.stringify({ redirectUri: t.__download }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return prev(input, init);
  };
}, ORIGINAL);

const { context, check, entryFor, swEval, history } = h;
const page = await context.newPage();
await page.goto('https://soundcloud.com/discover');
await waitFor(() => page.$$eval('.djh-btn', (b, n) => b.length >= n, ALL.length), { label: 'buttons' });
const done = (url, pred = (x) => !['searching', 'downloading'].includes(x.status)) => waitFor(async () => {
  const x = await entryFor(url);
  return x && pred(x) ? x : null;
}, { label: `result for ${url}`, timeout: 30000 });
const posix = (p) => (p || '').replace(/\\/g, '/');
// Persistent review cards sit over the bottom of the list (like on a real small screen).
const clearToasts = () => page.evaluate(() => document.getElementById('djh-root')?.shadowRoot?.querySelectorAll('.card .x').forEach((x) => x.click()));
const clickBtn = async (url, dbl = false) => {
  await clearToasts();
  await (dbl ? page.dblclick : page.click).call(page, `.djh-btn[data-url="${url}"]`);
};

await check('JSON pool + signed-URL download: preferred version, renamed', async () => {
  await clickBtn(JSON1.permalink_url);
  const e = await done(JSON1.permalink_url, (x) => ['downloaded', 'failed', 'error', 'want', 'review'].includes(x.status));
  assert.equal(e.status, 'downloaded', JSON.stringify(e.notes));
  assert.match(posix(e.file), /DJ Track Hunter\/DJDelivery\/Json Artist - Json Track \(Extended Mix\)\.wav$/);
  assert.ok(existsSync(e.file));
});

await check('logged-out pool is reported and the hunt falls through to the wantlist', async () => {
  poolState.loggedIn = false;
  await clickBtn(LOGGEDOUT.permalink_url);
  const e = await done(LOGGEDOUT.permalink_url);
  poolState.loggedIn = true;
  assert.equal(e.status, 'want', JSON.stringify(e));
  assert.ok(e.notes.some((n) => /DJDelivery: you’re logged out/.test(n)), JSON.stringify(e.notes));
});

await check('unsure match goes to review; picking a candidate in the toast downloads it', async () => {
  await clickBtn(REVIEW.permalink_url);
  const e = await done(REVIEW.permalink_url);
  assert.equal(e.status, 'review', JSON.stringify(e));
  const card = `#djh-root >> .card.review`;
  await page.waitForSelector(card, { timeout: 10000 });
  const labels = await page.$$eval('#djh-root >> .card.review .cand .t', (els) => els.map((x) => x.textContent));
  const idx = labels.findIndex((t) => /Original Mix/.test(t));
  assert.ok(idx >= 0, `original offered: ${labels}`);
  const buttons = await page.$$('#djh-root >> .card.review .cand .btn');
  await buttons[idx].click();
  const d = await done(REVIEW.permalink_url, (x) => x.status === 'downloaded');
  assert.match(posix(d.file), /Rev Artist - Pick Me \(Original Mix\)\.wav$/, 'named after what was downloaded, not the SoundCloud mix');
});

await check('daily cap: the 4th pool download of the day is refused (cap 3)', async () => {
  // JSON1 and REVIEW used 2 of 3; DOUBLE uses the 3rd; CAPPED must be refused.
  await clickBtn(DOUBLE.permalink_url, true);
  await done(DOUBLE.permalink_url, (x) => x.status === 'downloaded');
  await clickBtn(CAPPED.permalink_url);
  const e = await done(CAPPED.permalink_url);
  assert.notEqual(e.status, 'downloaded');
  assert.ok(e.notes.some((n) => /Daily cap reached/.test(n)), JSON.stringify(e.notes));
});

await check('double-click starts exactly one hunt', async () => {
  const n = (await history()).filter((x) => x.scUrl === DOUBLE.permalink_url).length;
  assert.equal(n, 1, `hunts for one double-click: ${n}`);
});

await check('artist-enabled SoundCloud download (original file)', async () => {
  await clickBtn(ORIGINAL.permalink_url);
  const e = await done(ORIGINAL.permalink_url, (x) => ['downloaded', 'failed', 'error', 'want', 'review'].includes(x.status));
  assert.equal(e.status, 'downloaded', JSON.stringify(e));
  assert.equal(e.source, 'sc-original');
  assert.match(posix(e.file), /DJ Track Hunter\/SoundCloud download\/Orig Artist - Straight From SC\.wav$/);
});

await check('an unrelated download while a gate is pending is left alone', async () => {
  await clickBtn(GATED.permalink_url);
  await done(GATED.permalink_url, (x) => x.status === 'gate');
  const other = await context.newPage();
  await other.goto(`${POOL_ORIGIN}/api/search?q=nothing`);
  await other.evaluate((u) => {
    const a = document.createElement('a');
    a.href = u;
    a.download = 'invoice.zip';
    document.body.appendChild(a);
    a.click();
  }, `${POOL_ORIGIN}/files/invoice.zip`);
  const item = await waitFor(async () => (await swEval(async () => (await chrome.downloads.search({ urlRegex: 'invoice' })).map((d) => ({ f: d.filename, s: d.state }))))[0], { label: 'unrelated download' });
  await waitFor(async () => (await swEval(async () => (await chrome.downloads.search({ urlRegex: 'invoice' }))[0]?.state)) === 'complete', { label: 'unrelated complete' });
  const final = (await swEval(async () => (await chrome.downloads.search({ urlRegex: 'invoice' }))[0].filename));
  assert.match(posix(final), /\/invoice\.zip$/, `not renamed: ${final} (${JSON.stringify(item)})`);
  assert.equal((await entryFor(GATED.permalink_url)).status, 'gate', 'gate entry untouched');
  await other.close();
});

await check('service worker killed while a gate is open: the file is still captured', async () => {
  await page.bringToFront();
  await clickBtn(SWKILL.permalink_url);
  await done(SWKILL.permalink_url, (x) => x.status === 'gate');
  const gate = await waitFor(() => context.pages().find((p) => p.url().includes('/gate/survive')), { label: 'gate tab' });
  // Kill the extension's service worker (as Chrome does after ~30 s idle).
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(h.extId));
  assert.ok(swTarget, 'found the worker target');
  await cdp.send('Target.closeTarget', { targetId: swTarget.targetId }).catch(() => {});
  await sleep(1500);
  await gate.bringToFront();
  await gate.click('#dl');
  // The download event wakes a fresh worker, which must restore the pending gate from storage.
  const want = join(h.downloadsDir, 'DJ Track Hunter', 'Free links on the track', 'Kill Artist - Survives Restart.wav');
  await waitFor(() => existsSync(want), { label: `renamed file ${want}`, timeout: 30000 });
  const e = await done(SWKILL.permalink_url, (x) => x.status === 'downloaded');
  assert.match(posix(e.file), /Kill Artist - Survives Restart\.wav$/);
});

await check('popup: a non-SoundCloud link shows an error instead of hanging', async () => {
  const pop = await context.newPage();
  await pop.goto(`chrome-extension://${h.extId}/src/ui/popup.html`);
  await pop.fill('#url', 'https://www.youtube.com/watch?v=abc');
  await pop.click('#hunt');
  const msg = await waitFor(() => pop.textContent('#msg').then((t) => (/SoundCloud/.test(t) && !/Hunting/.test(t) ? t : null)), { label: 'popup error' });
  assert.match(msg, /isn’t a SoundCloud track or set link/);
  await pop.close();
});

process.exit((await h.finish('robustness')) ? 1 : 0);
