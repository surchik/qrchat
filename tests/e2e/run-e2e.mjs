// End-to-end smoke test: loads the real extension into Chromium (Playwright) and drives it
// against MOCK SoundCloud / DJDelivery / Bandcamp / Hypeddit pages. It proves the extension's
// own wiring (injection, service worker pipeline, offscreen parsing, downloads + renaming,
// cart automation, gate capture). It does NOT prove the real sites' markup; see README.
//
// Run: npm run test:e2e   (needs Playwright + its Chromium; uses a global install if present)

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return import(pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href);
  }
}

// ---- mock DJDelivery pool --------------------------------------------------------------------

const FAKE_WAV = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(28)]);
const poolRow = (id, artist, title, version) => `
  <div class="track-row" data-id="${id}">
    <span class="artist">${artist}</span> <span class="title">${title}</span> <span class="ver">${version}</span>
    <span class="bpm">126</span> <span class="key">8A</span>
    <a class="dl" href="/dl/${id}">Download</a>
  </div>`;

const poolState = { nothingYetAvailable: false };

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        if (q.includes('nothing yet') && poolState.nothingYetAvailable) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(`<html><body>${poolRow(21, 'Nobody', 'Nothing Yet', 'Extended Mix')}</body></html>`);
          return;
        }
        const rows = q.includes('saving up')
          ? [poolRow(10, 'Dom Dolla', 'Saving Up', 'Acapella'), poolRow(11, 'Dom Dolla', 'Saving Up', 'Extended Mix'), poolRow(12, 'Dom Dolla', 'Saving Up', 'Clean'), poolRow(13, 'Dom Dolla', 'Rhyme Dust', 'Extended Mix')]
          : [];
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<html><body><h1>Results</h1>${rows.join('')}</body></html>`);
      } else if (url.pathname.startsWith('/dl/') || url.pathname.startsWith('/free/')) {
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-disposition': `attachment; filename="${url.pathname.startsWith('/dl/') ? 'pool_file_' : 'gate_'}${url.pathname.split('/').pop().replace(/\.wav$/, '')}.wav"`,
          'content-length': FAKE_WAV.length,
        });
        res.end(FAKE_WAV);
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Tabs the extension opens itself (Bandcamp cart, Hypeddit gate) start loading before Playwright
// can intercept them, so those hosts are served by a local HTTPS server via --host-resolver-rules.
function startHttpsServer(certDir, pages) {
  return new Promise((resolve) => {
    const server = createHttpsServer({
      key: readFileSync(join(certDir, 'key.pem')),
      cert: readFileSync(join(certDir, 'cert.pem')),
    }, (req, res) => {
      const host = (req.headers.host || '').split(':')[0];
      if (req.url.startsWith('/files/')) {
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-disposition': `attachment; filename="gate_${req.url.split('/').pop()}"`,
          'content-length': FAKE_WAV.length,
        });
        res.end(FAKE_WAV);
        return;
      }
      const body = pages[host];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
      res.end(body || 'not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---- fixtures served to the service worker's fetch() ----------------------------------------

const TRACKS = {
  'https://soundcloud.com/domdolla/saving-up': {
    kind: 'track', id: 1, title: 'Dom Dolla - Saving Up [OUT NOW]', user: { username: 'Dom Dolla' },
    permalink_url: 'https://soundcloud.com/domdolla/saving-up', downloadable: false, description: '', genre: 'House',
  },
  'https://soundcloud.com/obscure/rare-groove': {
    kind: 'track', id: 2, title: 'Obscure Artist - Rare Groove (Original Mix)', user: { username: 'Obscure Artist' },
    permalink_url: 'https://soundcloud.com/obscure/rare-groove', downloadable: false, description: '',
  },
  'https://soundcloud.com/gateartist/free-track': {
    kind: 'track', id: 3, title: 'Gate Artist - Free Track [FREE DL]', user: { username: 'Gate Artist' },
    permalink_url: 'https://soundcloud.com/gateartist/free-track', downloadable: false,
    purchase_url: 'https://hypeddit.com/gateartist/freetrack', purchase_title: 'FREE DOWNLOAD', description: 'Support on all platforms',
  },
};

const NOTHING_YET = {
  kind: 'track', id: 4, title: 'Nobody - Nothing Yet', user: { username: 'Nobody' },
  permalink_url: 'https://soundcloud.com/nobody/nothing-yet', downloadable: false, description: '',
};
TRACKS['https://soundcloud.com/digger/sets/crate'] = {
  kind: 'playlist', title: 'Crate', tracks: [TRACKS['https://soundcloud.com/domdolla/saving-up'], { id: 4 }],
};

const BANDCAMP_SEARCH = `<html><body><ul class="result-items">
  <li class="searchresult data-search">
    <div class="result-info">
      <div class="itemtype">TRACK</div>
      <div class="heading"><a href="https://obscureartist.bandcamp.com/track/rare-groove?from=search">Rare Groove</a></div>
      <div class="subhead">from Grooves EP by Obscure Artist</div>
      <div class="itemurl"><a href="https://obscureartist.bandcamp.com/track/rare-groove?from=search">https://obscureartist.bandcamp.com/track/rare-groove</a></div>
    </div>
  </li></ul></body></html>`;

const tralbum = JSON.stringify({ current: { minimum_price: 1.0, title: 'Rare Groove' }, freeDownloadPage: null, trackinfo: [{ duration: 401.2 }] });
const BANDCAMP_TRACK = `<html><head><script data-tralbum="${tralbum.replace(/"/g, '&quot;')}"></script></head>
<body>
  <h2>Rare Groove</h2>
  <h4><button class="download-link buy-link" onclick="document.getElementById('dlg').style.display='block'">Buy Digital Track</button></h4>
  <div id="dlg" style="display:none"><input id="userPrice" value="1.00">
    <button onclick="document.getElementById('sidecart').style.display='block'">Add to cart</button></div>
  <div id="sidecart" style="display:none">1 item in cart</div>
</body></html>`;

const SC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>SoundCloud mock</title></head><body><div id="app"><main>
  <ul>
    <li class="soundList__item"><div class="sound"><a class="soundTitle__title" href="/domdolla/saving-up"><span>Saving Up</span></a>
      <div class="soundActions"><div class="sc-button-group"><button class="sc-button-like">Like</button></div></div></div></li>
    <li class="soundList__item"><div class="sound"><a class="soundTitle__title" href="/obscure/rare-groove"><span>Rare Groove</span></a>
      <div class="soundActions"><div class="sc-button-group"><button class="sc-button-like">Like</button></div></div></div></li>
    <li class="soundList__item"><div class="sound"><a class="soundTitle__title" href="/gateartist/free-track"><span>Free Track</span></a>
      <div class="soundActions"><div class="sc-button-group"><button class="sc-button-like">Like</button></div></div></div></li>
  </ul>
  <div role="list"><div role="listitem"><button aria-label="Play">▶</button><a href="/newlayout/track-x">Track X</a> <a href="/newlayout">New Layout</a></div></div>
  <div class="comments"><li><a href="/someuser">someuser</a> nice</li></div>
</main></div></body></html>`;

// ---- run -----------------------------------------------------------------------------------------

const results = [];
// Optional: E2E_SCREENSHOTS=/some/dir saves screenshots of the injected UI, popup and settings.
const SHOTS = process.env.E2E_SCREENSHOTS;
async function shot(p, name) {
  if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}
function check(name, fn) {
  return fn().then(
    () => results.push({ name, ok: true }),
    (e) => results.push({ name, ok: false, error: e.message }),
  );
}

async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

const server = await startServer();
const PORT = server.address().port;
const POOL = `http://127.0.0.1:${PORT}`;

const work = mkdtempSync(join(tmpdir(), 'djh-e2e-'));
const extDir = join(work, 'ext');
cpSync(join(ROOT, 'extension'), extDir, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
const downloadsDir = join(work, 'downloads');
// Chrome's own download directory for the test profile (extension-chosen names are relative to it).
mkdirSync(join(work, 'profile', 'Default'), { recursive: true });
writeFileSync(join(work, 'profile', 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
}));

execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=localhost"`, { cwd: work, stdio: 'ignore' });
const GATE_PAGE = `<html><body><p>Mock gate</p><a id="dl" href="/files/freetrack.wav">Download</a>
  <script>setTimeout(() => document.getElementById('dl').click(), 800)</script></body></html>`;
const httpsServer = await startHttpsServer(work, { 'obscureartist.bandcamp.com': BANDCAMP_TRACK, 'hypeddit.com': GATE_PAGE });
const HTTPS_PORT = httpsServer.address().port;

const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  downloadsPath: downloadsDir,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `--host-resolver-rules=MAP obscureartist.bandcamp.com 127.0.0.1:${HTTPS_PORT}, MAP hypeddit.com 127.0.0.1:${HTTPS_PORT}`,
    '--ignore-certificate-errors',
    '--no-proxy-server',
  ],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  // Extension API bindings attach slightly after the worker registers.
  await waitFor(() => sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage?.local), { label: 'chrome.* in service worker' });

  // Playwright intercepts downloads by default; hand them back to Chrome so the extension's
  // onDeterminingFilename decides names, exactly as in a normal browser.
  const cdp = await context.newCDPSession(context.pages()[0] || (await context.newPage()));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch((e) => console.warn('setDownloadBehavior:', e.message));

  // Mock web pages (page-level requests).
  await context.route('https://soundcloud.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: SC_PAGE }));

  // Settings: point the DJDelivery adapter at the mock pool.
  await sw.evaluate(async (pool) => {
    await chrome.storage.local.set({
      settings: {
        djdelivery: {
          baseUrl: pool,
          searchUrl: `${pool}/search?q={query}`,
          transport: 'background',
          format: 'html',
          minIntervalMs: 50,
          html: { row: '.track-row', artist: '.artist', title: '.title', version: '.ver', download: 'a.dl@href', id: '@data-id', bpm: '.bpm', key: '.key' },
        },
      },
    });
    await chrome.storage.session.set({ scClientId: 'a'.repeat(32) });
  }, POOL);

  // Stub the service worker's fetch for SoundCloud's API and Bandcamp's search/track pages.
  async function installFetchStub() {
    await sw.evaluate(({ TRACKS, BANDCAMP_SEARCH, BANDCAMP_TRACK, NOTHING_YET }) => {
      if (self.__stubbed) return;
      self.__stubbed = true;
      const real = self.fetch.bind(self);
      const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      const html = (s) => new Response(s, { status: 200, headers: { 'content-type': 'text/html' } });
      self.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.host === 'api-v2.soundcloud.com') {
          if (url.pathname === '/resolve') return TRACKS[url.searchParams.get('url')] ? json(TRACKS[url.searchParams.get('url')]) : new Response('{}', { status: 404 });
          if (url.pathname === '/search/tracks') return json({ collection: [] });
          if (url.pathname === '/tracks') return json(url.searchParams.get('ids').split(',').map(Number).filter((id) => id === 4).map(() => NOTHING_YET));
          return new Response('{}', { status: 404 });
        }
        if (url.host === 'bandcamp.com' && url.pathname === '/search') return html(url.searchParams.get('q').includes('Rare Groove') ? BANDCAMP_SEARCH : '<ul class="result-items"></ul>');
        if (url.host === 'obscureartist.bandcamp.com') return html(BANDCAMP_TRACK);
        return real(input, init);
      };
    }, { TRACKS, BANDCAMP_SEARCH, BANDCAMP_TRACK, NOTHING_YET });
  }
  await installFetchStub();

  const page = await context.newPage();
  await page.goto('https://soundcloud.com/discover');

  await check('buttons injected on classic list items + heuristic new-layout item', async () => {
    const urls = await waitFor(async () => {
      const u = await page.$$eval('.djh-btn', (bs) => bs.map((b) => b.dataset.url));
      return u.length >= 4 ? u : null;
    }, { label: '4 buttons' });
    assert.deepEqual(urls.sort(), [
      'https://soundcloud.com/domdolla/saving-up',
      'https://soundcloud.com/gateartist/free-track',
      'https://soundcloud.com/newlayout/track-x',
      'https://soundcloud.com/obscure/rare-groove',
    ]);
  });

  await check('no floating button on non-track pages', async () => {
    const shown = await page.evaluate(() => document.getElementById('djh-root')?.shadowRoot?.querySelector('.fab')?.classList.contains('show'));
    assert.equal(shown, false);
  });

  const history = () => sw.evaluate(async () => (await chrome.storage.local.get('history')).history || []);
  const entryFor = async (scUrl) => (await history()).find((h) => h.scUrl === scUrl);

  await check('DJDelivery hit: downloads preferred version, renamed and filed', async () => {
    await installFetchStub();
    await page.click('.djh-btn[data-url="https://soundcloud.com/domdolla/saving-up"]');
    const e = await waitFor(async () => {
      const x = await entryFor('https://soundcloud.com/domdolla/saving-up');
      return x && ['downloaded', 'failed', 'error', 'review', 'want'].includes(x.status) ? x : null;
    }, { label: 'pool download' });
    assert.equal(e.status, 'downloaded', JSON.stringify(e));
    assert.equal(e.source, 'djdelivery');
    assert.equal(e.chosen.version, 'Extended Mix', 'preferred version picked over Acapella/Clean');
    assert.match(e.file.replace(/\\/g, '/'), /DJ Track Hunter\/DJDelivery\/Dom Dolla - Saving Up \(Extended Mix\)\.wav$/);
    assert.ok(existsSync(e.file), `file exists at ${e.file}`);
    const state = await page.getAttribute('.djh-btn[data-url="https://soundcloud.com/domdolla/saving-up"]', 'data-state');
    assert.equal(state, 'done');
  });

  await check('toast shows the result', async () => {
    const text = await waitFor(() => page.evaluate(() => document.getElementById('djh-root')?.shadowRoot?.querySelector('.card.done .msg')?.textContent), { label: 'toast' });
    assert.match(text, /Saved .*Saving Up/);
    await shot(page, 'soundcloud-toast');
  });

  await check('second click reports "already downloaded"', async () => {
    await page.click('.djh-btn[data-url="https://soundcloud.com/domdolla/saving-up"]');
    await waitFor(async () => (await history()).filter((h) => h.scUrl === 'https://soundcloud.com/domdolla/saving-up' && h.status === 'owned').length === 1, { label: 'owned entry' });
  });

  await check('not in pool -> Bandcamp paid -> added to cart', async () => {
    await installFetchStub();
    await page.click('.djh-btn[data-url="https://soundcloud.com/obscure/rare-groove"]');
    const e = await waitFor(async () => {
      const x = await entryFor('https://soundcloud.com/obscure/rare-groove');
      return x && !['searching'].includes(x.status) ? x : null;
    }, { label: 'bandcamp cart', timeout: 30000 });
    assert.equal(e.status, 'cart', JSON.stringify(e));
    assert.equal(e.source, 'bandcamp');
    assert.ok(e.notes.some((n) => /DJDelivery: no match/.test(n)), 'pool was searched first');
  });

  await check('free gate link -> gate opened -> download captured and renamed', async () => {
    await installFetchStub();
    await page.bringToFront();
    await page.click('.djh-btn[data-url="https://soundcloud.com/gateartist/free-track"]');
    const e = await waitFor(async () => {
      const x = await entryFor('https://soundcloud.com/gateartist/free-track');
      return x && x.status === 'downloaded' ? x : null;
    }, { label: 'gate capture', timeout: 30000 });
    assert.match(e.file.replace(/\\/g, '/'), /DJ Track Hunter\/Free links on the track\/Gate Artist - Free Track\.wav$/);
    assert.ok(existsSync(e.file));
  });

  await check('floating button appears on a track page', async () => {
    await page.goto('https://soundcloud.com/obscure/rare-groove');
    await waitFor(() => page.evaluate(() => document.getElementById('djh-root')?.shadowRoot?.querySelector('.fab.show') != null), { label: 'fab' });
  });

  await check('button badges restore from history after reload', async () => {
    await page.goto('https://soundcloud.com/discover');
    await waitFor(async () => (await page.getAttribute('.djh-btn[data-url="https://soundcloud.com/domdolla/saving-up"]', 'data-state')) === 'done', { label: 'restored badge' });
    assert.equal(await page.getAttribute('.djh-btn[data-url="https://soundcloud.com/obscure/rare-groove"]', 'data-state'), 'cart');
  });

  await check('whole set: owned track skipped, missing track wantlisted', async () => {
    await installFetchStub();
    await page.goto('https://soundcloud.com/digger/sets/crate');
    await waitFor(() => page.evaluate(() => document.getElementById('djh-root')?.shadowRoot?.querySelector('.fab.show span')?.textContent === 'Hunt whole set'), { label: 'set fab' });
    await page.click('.fab.show');
    const e = await waitFor(async () => {
      const x = await entryFor('https://soundcloud.com/digger/sets/crate');
      return x && x.status === 'batch' && x.summary ? x : null;
    }, { label: 'batch summary', timeout: 30000 });
    assert.match(e.summary, /1 owned/);
    assert.match(e.summary, /1 want/);
    const want = await sw.evaluate(async () => (await chrome.storage.local.get('wantlist')).wantlist || []);
    assert.ok(want.some((w) => w.scUrl === 'https://soundcloud.com/nobody/nothing-yet' && w.status === 'missing'));
  });

  await check('wantlist re-check downloads the track once the pool has it', async () => {
    await installFetchStub();
    poolState.nothingYetAvailable = true;
    const pop = await context.newPage();
    await pop.goto(`chrome-extension://${extId}/src/ui/popup.html`);
    await pop.click('#recheck');
    await waitFor(() => pop.textContent('#msg').then((t) => /found 1/.test(t)), { label: 'recheck result', timeout: 30000 });
    const e = await waitFor(async () => {
      const x = (await history()).find((h) => h.scUrl === 'https://soundcloud.com/nobody/nothing-yet' && h.origin === 'wantlist');
      return x && x.status === 'downloaded' ? x : null;
    }, { label: 'wantlist download' });
    assert.match(e.file.replace(/\\/g, '/'), /Nobody - Nothing Yet \(Extended Mix\)\.wav$/);
    const want = await sw.evaluate(async () => (await chrome.storage.local.get('wantlist')).wantlist || []);
    assert.equal(want.find((w) => w.scUrl === 'https://soundcloud.com/nobody/nothing-yet').status, 'found');
    await pop.close();
  });

  await check('options page renders and test-search works against the mock pool', async () => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extId}/src/ui/options.html`);
    await opt.fill('#test-q', 'Dom Dolla - Saving Up');
    await opt.click('#test-run');
    const status = await waitFor(() => opt.textContent('#test-status').then((t) => (/result/.test(t) ? t : null)), { label: 'test search' });
    assert.match(status, /4 result/);
    const rows = await opt.$$eval('#test-table tr', (trs) => trs.length);
    assert.equal(rows, 5);
    await opt.setViewportSize({ width: 1000, height: 900 });
    await opt.evaluate(() => document.querySelector('#test-q').scrollIntoView());
    await shot(opt, 'options-test-search');
    await opt.close();
  });

  await check('popup lists history', async () => {
    const pop = await context.newPage();
    await pop.goto(`chrome-extension://${extId}/src/ui/popup.html`);
    await waitFor(() => pop.$$eval('#history li', (lis) => lis.length >= 3), { label: 'popup rows' });
    await pop.setViewportSize({ width: 400, height: 600 });
    await shot(pop, 'popup');
    await pop.close();
  });

  const errors = await sw.evaluate(() => self.__errors || []);
  if (errors.length) console.warn('SW errors:', errors);
} finally {
  await context.close();
  server.close();
  httpsServer.close();
  const files = existsSync(downloadsDir) ? readdirSync(downloadsDir, { recursive: true }) : [];
  console.log('downloads dir:', files);
  rmSync(work, { recursive: true, force: true });
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} e2e checks passed`);
process.exit(failed ? 1 : 0);
