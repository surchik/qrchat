// Shared end-to-end harness: loads the real extension into Playwright's Chromium, serves mock
// sites over local HTTPS (mapped with --host-resolver-rules so tabs the extension opens itself
// hit the mocks too), stubs the service worker's fetch() for SoundCloud's API, and lets Chrome
// (not Playwright) handle downloads so the extension's filename logic is what decides names.

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAKE_WAV = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(28)]);

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return import(pathToFileURL(join(globalRoot, 'playwright', 'index.mjs')).href);
  }
}

export async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {(host:string, path:string, req:any, res:any) => boolean} o.https  handle a request to a mapped host; return true if handled
 * @param {string[]} o.hosts  hostnames mapped to the local HTTPS server
 * @param {(req:any, res:any) => boolean} [o.pool]  handler for the plain-HTTP mock pool
 * @param {object} o.tracks  SoundCloud API fixtures: url -> resolve() payload (tracks/playlists)
 * @param {object} [o.settings]  extension settings to store
 */
export async function setup(o) {
  const work = mkdtempSync(join(tmpdir(), 'djh-e2e-'));
  execSync('openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj "/CN=localhost"', { cwd: work, stdio: 'ignore' });

  const pool = createServer((req, res) => {
    if (!o.pool || !o.pool(req, res)) {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((r) => pool.listen(0, '127.0.0.1', r));
  const POOL = `http://127.0.0.1:${pool.address().port}`;

  const https = createHttpsServer({ key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) }, (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const path = req.url;
    if (!o.https(host, path, req, res)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => https.listen(0, '127.0.0.1', r));
  const HTTPS_PORT = https.address().port;

  const extDir = join(work, 'ext');
  cpSync(join(ROOT, 'extension'), extDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const downloadsDir = join(work, 'downloads');
  mkdirSync(join(work, 'profile', 'Default'), { recursive: true });
  writeFileSync(join(work, 'profile', 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
  }));

  const { chromium } = await loadPlaywright();
  const context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      `--host-resolver-rules=${o.hosts.map((h) => `MAP ${h} 127.0.0.1:${HTTPS_PORT}`).join(', ')}`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await waitFor(() => sw.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage?.local), { label: 'chrome.* in service worker' });

  const cdp = await context.newCDPSession(context.pages()[0] || (await context.newPage()));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });

  const settings = typeof o.settings === 'function' ? o.settings(POOL) : o.settings || {};
  await sw.evaluate(async (s) => {
    await chrome.storage.local.set({ settings: s });
    await chrome.storage.session.set({ scClientId: 'a'.repeat(32) });
  }, settings);

  // The worker can be restarted by Chrome; re-install the stub before each scenario.
  async function stub() {
    const alive = await sw.evaluate(() => true).catch(() => false);
    if (!alive) {
      const live = [...context.serviceWorkers()].reverse().find((w) => w.url().includes(extId));
      if (!live || !(await live.evaluate(() => true).catch(() => false))) return; // nothing to stub right now
      sw = live;
    }
    await sw.evaluate((TRACKS) => {
      if (self.__stubbed) return;
      self.__stubbed = true;
      const real = self.fetch.bind(self);
      const byId = new Map();
      for (const v of Object.values(TRACKS)) {
        if (v.kind === 'track') byId.set(v.id, v);
        for (const t of v.tracks || []) if (t.title) byId.set(t.id, t);
      }
      for (const v of Object.values(TRACKS)) for (const t of v.hiddenTracks || []) byId.set(t.id, t);
      const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
      self.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.host === 'api-v2.soundcloud.com') {
          self.__scCalls = (self.__scCalls || 0) + 1;
          if (url.pathname === '/resolve') {
            const hit = TRACKS[url.searchParams.get('url')];
            return hit ? json({ ...hit, hiddenTracks: undefined }) : json({}, 404);
          }
          if (url.pathname === '/search/tracks') return json({ collection: [] });
          if (url.pathname === '/tracks') return json(url.searchParams.get('ids').split(',').map(Number).map((id) => byId.get(id)).filter(Boolean));
          const dl = url.pathname.match(/^\/tracks\/(\d+)\/download$/);
          if (dl) {
            const t = byId.get(Number(dl[1]));
            return t?.__download ? json({ redirectUri: t.__download }) : json({}, 404);
          }
          return json({}, 404);
        }
        if (url.host === 'bandcamp.com' && url.pathname === '/search') return new Response('<ul class="result-items"></ul>', { status: 200 });
        return real(input, init);
      };
    }, o.tracks);
  }
  await stub();

  const results = [];
  async function check(name, fn) {
    const t0 = Date.now();
    try {
      await stub();
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ name, ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

  /** After Chrome restarts the service worker, point at the new instance (and re-stub it). */
  async function refreshSw() {
    // The old handle stays in the list after the worker dies; take whichever one answers.
    await waitFor(async () => {
      for (const w of [...context.serviceWorkers()].reverse()) {
        if (!w.url().includes(extId)) continue;
        if (await w.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage?.local).catch(() => false)) {
          sw = w;
          return true;
        }
      }
      return false;
    }, { label: 'restarted worker', timeout: 30000 });
    await stub();
    return sw;
  }

  let extPage = null;
  /** Read extension storage through an extension page (works even if the worker handle is gone). */
  async function storageGet(key) {
    if (!extPage || extPage.isClosed()) {
      extPage = await context.newPage();
      await extPage.goto(`chrome-extension://${extId}/src/ui/popup.html`);
    }
    return extPage.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
  }
  const history = async () => (await storageGet('history')) || [];
  const entryFor = async (scUrl, pred = () => true) => (await history()).find((h) => h.scUrl === scUrl && pred(h));
  const swEval = (fn, arg) => sw.evaluate(fn, arg);

  async function finish(suite) {
    await context.close().catch(() => {});
    pool.close();
    https.close();
    const files = existsSync(downloadsDir) ? readdirSync(downloadsDir, { recursive: true }).filter((f) => /\.\w+$/.test(f)) : [];
    rmSync(work, { recursive: true, force: true });
    console.log(`\n[${suite}] downloaded files:`, files);
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)${r.ok ? '' : `\n      ${r.error}`}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`[${suite}] ${results.length - failed}/${results.length} checks passed`);
    return failed;
  }

  return { context, extId, POOL, downloadsDir, check, history, entryFor, swEval, finish, stub, refreshSw, storageGet, getSw: () => sw };
}

export function audio(res, name, delayMs = 0) {
  setTimeout(() => {
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': FAKE_WAV.length,
    });
    res.end(FAKE_WAV);
  }, delayMs);
}

export function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}
