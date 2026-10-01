// Gate suite: realistic multi-step download gates (Hypeddit-style), driven by the autopilot.
//  1. Single hunt: gate opens in a NEW foreground tab right next to the SoundCloud tab; the
//     autopilot clicks "Connect with SoundCloud", approves the OAuth popup (redirect goes back
//     to hypeddit.com), fills the email, follows + reposts, clicks Download; the file is
//     captured, renamed, filed, and the gate tab is closed.
//  2. Whole set with three gates on the same host: all open at once in a "Gates" tab group;
//     downloads finish in a different order than they started; every file gets the right name.
//  3. Safety: an OAuth screen that redirects to an unknown domain is NOT approved.
//  4. Guide mode: banner only, nothing is clicked, the user's own click is still captured.

import assert from 'node:assert/strict';
import { setup, waitFor, sleep, audio, html } from './harness.mjs';

const GATE_HOST = 'hypeddit.com';

function gatePage(slug, { redirect } = {}) {
  const redirectUri = redirect || `https://${GATE_HOST}/callback`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gate ${slug}</title></head><body>
  <h1>Free download: ${slug}</h1>
  <div id="step1"><button id="connect">Connect with SoundCloud</button></div>
  <div id="step2" style="display:none">
    <input type="email" id="email" placeholder="Your email">
    <button id="follow">Follow Gate Artist</button>
    <button id="repost">Repost</button>
    <button id="buy">Buy on Beatport</button>
    <a id="dl" href="/files/${slug}.wav" style="display:none">Download</a>
  </div>
  <script>
    window.__log = [];
    const st = { follow: false, repost: false };
    const $ = (id) => document.getElementById(id);
    $('connect').onclick = () => { __log.push('connect'); window.open('https://soundcloud.com/connect?client_id=hyp&response_type=code&redirect_uri=' + encodeURIComponent(${JSON.stringify(redirectUri)}), 'oauth', 'width=500,height=600'); };
    window.addEventListener('message', (e) => { if (e.data === 'connected') { __log.push('connected'); $('step1').style.display = 'none'; $('step2').style.display = 'block'; } });
    $('follow').onclick = () => { st.follow = true; __log.push('follow'); $('follow').textContent = 'Following'; $('follow').disabled = true; check(); };
    $('repost').onclick = () => { st.repost = true; __log.push('repost'); $('repost').textContent = 'Reposted'; $('repost').disabled = true; check(); };
    $('buy').onclick = () => { __log.push('BUY-CLICKED'); document.title = 'BUY-CLICKED'; };
    $('email').addEventListener('input', check);
    function check() { if (st.follow && st.repost && /@/.test($('email').value)) $('dl').style.display = 'inline'; }
  </script></body></html>`;
}

const OAUTH_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Authorize</title></head><body>
  <h1>Hypeddit wants to access your SoundCloud account</h1>
  <button id="ok">Connect</button> <button id="no">Cancel</button>
  <script>
    document.getElementById('ok').onclick = () => { document.title = 'APPROVED'; location.href = new URL(location.href).searchParams.get('redirect_uri') + '?code=abc'; };
    document.getElementById('no').onclick = () => { document.title = 'CANCELLED'; };
  </script></body></html>`;

const CALLBACK_PAGE = `<!doctype html><html><body>ok<script>
  if (window.opener) window.opener.postMessage('connected', '*'); setTimeout(() => window.close(), 300);
</script></body></html>`;

const track = (id, user, slug, title, gate) => ({
  kind: 'track', id, title, user: { username: user },
  permalink_url: `https://soundcloud.com/${user.toLowerCase().replace(/\s+/g, '')}/${slug}`,
  downloadable: false, purchase_url: gate, purchase_title: 'FREE DOWNLOAD', description: '',
});

const SINGLE = track(31, 'Gate Artist', 'free-track', 'Gate Artist - Free Track [FREE DL]', `https://${GATE_HOST}/gateartist/single`);
const G1 = track(41, 'Crew', 'gate-one', 'Crew Artist - Gate One (Extended Mix)', `https://${GATE_HOST}/crew/g1`);
const G2 = track(42, 'Crew', 'gate-two', 'Crew Artist - Gate Two', `https://${GATE_HOST}/crew/g2`);
const G3 = track(43, 'Crew', 'gate-three', 'Crew Artist - Gate Three (VIP)', `https://${GATE_HOST}/crew/g3`);
const EVIL = track(51, 'Shady', 'shady', 'Shady - Phish Track', `https://${GATE_HOST}/shady/evil`);
const GUIDE = track(61, 'Hand', 'by-hand', 'Hand Artist - By Hand', `https://${GATE_HOST}/hand/manual`);

const TRACKS = Object.fromEntries([SINGLE, G1, G2, G3, EVIL, GUIDE].map((t) => [t.permalink_url, t]));
TRACKS['https://soundcloud.com/crew/sets/gates'] = { kind: 'playlist', title: 'Gates', tracks: [G1, { id: 42 }, { id: 43 }], hiddenTracks: [G2, G3] };

const SC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>SoundCloud mock</title></head><body><main><ul>
  ${Object.values(TRACKS).filter((t) => t.kind === 'track').map((t) => `<li class="soundList__item"><a class="soundTitle__title" href="${new URL(t.permalink_url).pathname}">${t.title}</a>
  <div class="soundActions"><div class="sc-button-group"><button>Like</button></div></div></li>`).join('\n')}
</ul></main></body></html>`;

// Downloads finish out of order on purpose (g1 slowest).
const DELAYS = { g1: 3000, g2: 300, g3: 1500 };

const h = await setup({
  hosts: ['soundcloud.com', GATE_HOST],
  tracks: TRACKS,
  settings: { sources: { djdelivery: { enabled: false } }, gates: { mode: 'auto', email: 'dj@example.com', autoApproveOAuth: true, closeAfterCapture: true } },
  https(host, path, req, res) {
    const url = new URL(path, `https://${host}`);
    if (host === 'soundcloud.com') {
      if (url.pathname === '/connect') return html(res, OAUTH_PAGE), true;
      return html(res, SC_PAGE), true;
    }
    if (host === GATE_HOST) {
      if (url.pathname === '/callback') return html(res, CALLBACK_PAGE), true;
      const file = url.pathname.match(/^\/files\/(\w+)\.wav$/);
      if (file) return audio(res, `hypeddit_${file[1]}_download.wav`, DELAYS[file[1]] || 0), true;
      if (url.pathname === '/shady/evil') return html(res, gatePage('evil', { redirect: 'https://evil.example/steal' })), true;
      const slug = url.pathname.split('/').pop();
      return html(res, gatePage(slug)), true;
    }
    return false;
  },
});

const { context, check, entryFor, swEval } = h;
const page = await context.newPage();
await page.goto('https://soundcloud.com/discover');
await waitFor(() => page.$$eval('.djh-btn', (b) => b.length >= 6), { label: 'buttons' });
const tabsInfo = () => swEval(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url || t.pendingUrl || '', index: t.index, active: t.active, groupId: t.groupId, windowId: t.windowId })));

let gateTabSeen = null;

await check('single gate opens in a NEW foreground tab right next to the SoundCloud tab', async () => {
  const before = await tabsInfo();
  const sc = before.find((t) => t.url.startsWith('https://soundcloud.com/discover'));
  await page.click(`.djh-btn[data-url="${SINGLE.permalink_url}"]`);
  const gate = await waitFor(async () => (await tabsInfo()).find((t) => t.url?.includes('/gateartist/single')), { label: 'gate tab' });
  gateTabSeen = gate;
  assert.equal(gate.active, true, 'gate tab is focused');
  assert.equal(gate.windowId, sc.windowId, 'same window');
  assert.equal(gate.index, sc.index + 1, 'right next to the SoundCloud tab');
  assert.equal(gate.groupId, -1, 'single hunts are not grouped');
});

await check('autopilot: connect → approve OAuth popup → email → follow → repost → download; never clicks Buy', async () => {
  const gatePageObj = await waitFor(() => context.pages().find((p) => p.url().includes('/gateartist/single')), { label: 'gate page object' });
  const banner = await waitFor(() => gatePageObj.evaluate(() => {
    const roots = [...document.querySelectorAll('body > div')].map((d) => d.shadowRoot).filter(Boolean);
    return roots.map((r) => r.querySelector('.msg')?.textContent).find(Boolean) || null;
  }).catch(() => null), { label: 'autopilot banner' });
  assert.match(banner, /DJ Track Hunter/);
  const e = await waitFor(async () => {
    const x = await entryFor(SINGLE.permalink_url);
    return x?.status === 'downloaded' ? x : null;
  }, { label: 'captured gate download', timeout: 45000 }).catch(async (err) => {
    const diag = {
      log: await gatePageObj.evaluate(() => window.__log).catch((x) => String(x)),
      banner: await gatePageObj.evaluate(() => [...document.querySelectorAll('body > div')].map((d) => d.shadowRoot?.querySelector('.msg')?.textContent).filter(Boolean)).catch((x) => String(x)),
      pages: context.pages().map((p) => p.url()),
      entry: await entryFor(SINGLE.permalink_url),
      captures: await swEval(async () => (await chrome.storage.session.get('dl')).dl),
      downloads: await swEval(async () => (await chrome.downloads.search({})).map((d) => ({ url: d.url, referrer: d.referrer, filename: d.filename, state: d.state, error: d.error }))),
    };
    throw new Error(`${err.message}\nDIAG ${JSON.stringify(diag, null, 1)}`);
  });
  assert.match(e.file.replace(/\\/g, '/'), /DJ Track Hunter\/Free links on the track\/Gate Artist - Free Track\.wav$/);
  const log = await gatePageObj.evaluate(() => window.__log).catch(() => null);
  if (log) {
    assert.ok(!log.includes('BUY-CLICKED'), 'never clicks Buy');
    for (const step of ['connect', 'connected', 'follow', 'repost']) assert.ok(log.includes(step), `did ${step}: ${log}`);
  }
});

await check('gate tab is closed after the file is captured', async () => {
  await waitFor(async () => !(await tabsInfo()).some((t) => t.id === gateTabSeen.id), { label: 'gate tab closed', timeout: 10000 });
});

await check('whole set: 3 gates on the same host open at once in a "Gates" tab group', async () => {
  await page.goto('https://soundcloud.com/crew/sets/gates');
  await waitFor(() => page.evaluate(() => document.getElementById('djh-root')?.shadowRoot?.querySelector('.fab.show') != null), { label: 'set fab' });
  await page.click('.fab.show');
  const groups = await waitFor(async () => {
    const tabs = await tabsInfo();
    const gates = tabs.filter((t) => /\/crew\/g[123]$/.test(t.url || ''));
    if (gates.length < 3) return null;
    const ids = [...new Set(gates.map((t) => t.groupId))];
    const info = await swEval(async (gid) => chrome.tabGroups.get(gid).catch(() => null), ids[0]);
    return { gates, ids, info };
  }, { label: 'three grouped gate tabs', timeout: 30000 });
  assert.equal(groups.ids.length, 1, 'all three in one group');
  assert.notEqual(groups.ids[0], -1, 'actually grouped');
  assert.match(groups.info.title, /^Gates/);
  assert.ok(groups.gates.every((t) => !t.active), 'batch gates open in the background');
});

await check('3 concurrent gates, out-of-order downloads: every file gets the right name', async () => {
  const want = {
    [G1.permalink_url]: /Crew Artist - Gate One \(Extended Mix\)\.wav$/,
    [G2.permalink_url]: /Crew Artist - Gate Two\.wav$/,
    [G3.permalink_url]: /Crew Artist - Gate Three \(VIP\)\.wav$/,
  };
  for (const [url, re] of Object.entries(want)) {
    const e = await waitFor(async () => {
      const x = await entryFor(url, (y) => y.origin === 'batch');
      return x?.status === 'downloaded' ? x : null;
    }, { label: `download for ${url}`, timeout: 60000 });
    assert.match(e.file.replace(/\\/g, '/'), re, `${url} -> ${e.file}`);
  }
});

await check('safety: OAuth that redirects to an unknown domain is NOT approved', async () => {
  await page.goto('https://soundcloud.com/discover');
  await waitFor(() => page.$$eval('.djh-btn', (b) => b.length >= 6), { label: 'buttons' });
  await page.click(`.djh-btn[data-url="${EVIL.permalink_url}"]`);
  const popup = await waitFor(() => context.pages().find((p) => p.url().startsWith('https://soundcloud.com/connect') && p.url().includes('evil.example')), { label: 'evil oauth popup', timeout: 20000 });
  // The autopilot must be running on this popup (banner shown) yet refuse to approve it.
  const banner = await waitFor(() => popup.evaluate(() => [...document.querySelectorAll('body > div')].map((d) => d.shadowRoot?.querySelector('.msg')?.textContent).find(Boolean) || null).catch(() => null), { label: 'banner on untrusted oauth popup' });
  assert.match(banner, /DJ Track Hunter/);
  await sleep(7000); // several autopilot cycles
  const title = await popup.title().catch(() => 'closed');
  assert.notEqual(title, 'APPROVED', 'must not approve');
  assert.equal(title, 'Authorize');
  await popup.close().catch(() => {});
});

await check('guide mode: banner only, nothing auto-clicked, your own click is still captured', async () => {
  await swEval(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.gates.mode = 'guide';
    await chrome.storage.local.set({ settings });
  });
  await page.bringToFront();
  await page.click(`.djh-btn[data-url="${GUIDE.permalink_url}"]`);
  const gp = await waitFor(() => context.pages().find((p) => p.url().includes('/hand/manual')), { label: 'guide gate tab' });
  await gp.waitForLoadState();
  await sleep(4000);
  assert.deepEqual(await gp.evaluate(() => window.__log), [], 'nothing clicked automatically');
  // The user does the gate by hand (simulated): connect → popup → approve → follow/repost/email → download.
  const popupPromise = context.waitForEvent('page');
  await gp.click('#connect');
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await popup.click('#ok');
  await waitFor(() => gp.evaluate(() => window.__log.includes('connected')), { label: 'connected' });
  await gp.fill('#email', 'me@example.com');
  await gp.click('#follow');
  await gp.click('#repost');
  await gp.click('#dl');
  const e = await waitFor(async () => {
    const x = await entryFor(GUIDE.permalink_url);
    return x?.status === 'downloaded' ? x : null;
  }, { label: 'manual gate captured', timeout: 30000 });
  assert.match(e.file.replace(/\\/g, '/'), /Hand Artist - By Hand\.wav$/);
});

process.exit((await h.finish('gates')) ? 1 : 0);
