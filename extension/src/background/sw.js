// Service worker entry: registers every listener synchronously at top level (MV3 requirement)
// and routes messages from the SoundCloud content script, popup and options page.

import { hunt, act, wantFromEntry, recheckWantlist, checkHuntUrl, reconcileDownloads } from './pipeline.js';
import { initDownloadListeners } from './downloads.js';
import { initGateListeners, gateContext, armCapture, applyPopupPolicy } from './gates.js';
import { captureClientId } from '../adapters/soundcloud.js';
import { searchPool } from '../adapters/pool.js';
import { scoreCandidate } from '../lib/match.js';
import { parseSoundCloudTrack } from '../lib/normalize.js';
import { getSettings } from '../lib/settings.js';
import * as store from '../lib/store.js';
import { logRequest, setDiscoveryEnabled, getLog, clearLog } from './discovery.js';

const WANT_ALARM = 'wantlist-recheck';

initDownloadListeners();
initGateListeners();

chrome.webRequest.onBeforeRequest.addListener(captureClientId, { urls: ['https://api-v2.soundcloud.com/*'] });
chrome.webRequest.onCompleted.addListener(
  logRequest,
  { urls: ['*://djdelivery.com/*', '*://*.djdelivery.com/*'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'other', 'media'] },
  ['responseHeaders'],
);

async function applySettings() {
  const s = await getSettings();
  setDiscoveryEnabled(s.discovery.enabled);
  applyPopupPolicy().catch((e) => console.warn('[DJ Track Hunter] popup policy', e));
  const period = Math.max(1, Number(s.wantlist.intervalHours) || 12) * 60;
  const existing = await chrome.alarms.get(WANT_ALARM);
  if (!s.wantlist.enabled) {
    if (existing) await chrome.alarms.clear(WANT_ALARM);
  } else if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create(WANT_ALARM, { delayInMinutes: Math.min(period, 30), periodInMinutes: period });
  }
}
applySettings();
reconcileDownloads().catch(() => {});

function startHunt(args) {
  hunt(args).catch((e) => console.warn('[DJ Track Hunter] hunt failed', e));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applySettings();
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'hunt-link',
      title: 'Hunt this track (DJ Track Hunter)',
      contexts: ['link'],
      targetUrlPatterns: ['https://soundcloud.com/*'],
    });
    chrome.contextMenus.create({
      id: 'hunt-page',
      title: 'Hunt this track (DJ Track Hunter)',
      contexts: ['page'],
      documentUrlPatterns: ['https://soundcloud.com/*/*'],
    });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'hunt-link' ? info.linkUrl : info.pageUrl;
  if (url) startHunt({ url, tabId: tab?.id ?? null, origin: 'context-menu' });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'hunt-current') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://soundcloud.com/')) return;
  let url = tab.url;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'get-current-track' });
    if (res?.url) url = res.url;
  } catch {
    // content script not ready; fall back to the page URL
  }
  startHunt({ url, tabId: tab.id, origin: 'shortcut' });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WANT_ALARM) recheckWantlist();
});

async function testPool(q) {
  const settings = await getSettings();
  const query = parseSoundCloudTrack({ title: q });
  const res = await searchPool(settings.djdelivery, query);
  return {
    ...res,
    query,
    items: (res.items || []).map((it) => ({ ...it, raw: undefined, ...scoreCandidate(query, it) })),
  };
}

const HANDLERS = {
  // From the SoundCloud page.
  hunt: (msg, sender) => {
    // Validate now (so the popup sees a real error), then respond immediately; progress
    // streams back to the tab as 'hunt-progress' messages.
    checkHuntUrl(msg.url);
    startHunt({ url: msg.url, tabId: sender.tab?.id ?? null, origin: msg.origin || 'button', force: !!msg.force });
    return { started: true };
  },
  act: (msg, sender) => act({ entryId: msg.entryId, cid: msg.cid, tabId: sender.tab?.id ?? null }),
  want: (msg) => wantFromEntry(msg.entryId),
  'status-for-urls': (msg) => store.statusForUrls(msg.urls || []),

  // From gate tabs (src/content/gate.js).
  'gate-context': (msg, sender) => (sender.tab ? gateContext(sender.tab.id, msg.url || sender.url) : { active: false }),
  'gate-armed': (msg, sender) => (sender.tab ? armCapture(sender.tab.id) : null),

  // From the popup / options page.
  'list-history': (msg) => store.listEntries(msg.limit || 50),
  'list-want': () => store.listWant(),
  'remove-want': (msg) => store.removeWant(msg.scUrl),
  'recheck-want': () => recheckWantlist({ force: true }),
  'clear-history': () => store.clearHistory(),
  'test-pool': (msg) => testPool(msg.q || ''),
  'discovery-log': () => getLog(),
  'discovery-clear': () => clearLog(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const handler = HANDLERS[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
