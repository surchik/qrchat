// Gate tabs: open a free-download gate in a new Chrome tab so you can pass it (single hunt:
// foreground, right next to the SoundCloud tab; whole-set hunt: every gate at once in a
// "Gates" tab group). Tabs the gate spawns (OAuth popups, Dropbox pages) are followed, the
// autopilot script is injected into each of them, and they are closed once the file lands.

import { registerCapture, captureForTab, addGateTab, armCapture, dropCapture, liveCaptures } from './downloads.js';
import { getSettings } from '../lib/settings.js';
import { hostOf } from '../lib/freelinks.js';

const GROUP_KEY = 'gateGroups'; // batchId -> groupId, in storage.session

async function groupFor(batchId, windowId, tabId, total) {
  const { [GROUP_KEY]: groups = {} } = await chrome.storage.session.get(GROUP_KEY);
  let groupId = groups[batchId];
  try {
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      groups[batchId] = groupId;
      await chrome.storage.session.set({ [GROUP_KEY]: groups });
    }
    const count = (await chrome.tabs.query({ groupId })).length;
    await chrome.tabGroups.update(groupId, { title: `Gates (${count}${total ? `/${total}` : ''})`, color: 'purple', collapsed: false });
  } catch (e) {
    // The group was closed by the user: start a new one.
    if (groupId != null) {
      delete groups[batchId];
      await chrome.storage.session.set({ [GROUP_KEY]: groups });
      return groupFor(batchId, windowId, tabId, total);
    }
    throw e;
  }
  return groupId;
}

/**
 * Open `url` as a gate for the hunt `entryId` and start watching for its download.
 * @returns {Promise<number>} the gate tab id
 */
export async function openGate({ url, entryId, baseName, folder, label, sourceTabId, batchId = null, batchTotal = 0, extraHosts = [] }) {
  let opener = null;
  if (sourceTabId != null) opener = await chrome.tabs.get(sourceTabId).catch(() => null);
  const createProps = { url, active: !batchId };
  if (opener) {
    createProps.windowId = opener.windowId;
    createProps.index = opener.index + 1;
    createProps.openerTabId = opener.id;
  }
  let tab;
  try {
    tab = await chrome.tabs.create(createProps);
  } catch {
    tab = await chrome.tabs.create({ url, active: !batchId });
  }
  await registerCapture({
    entryId,
    baseName,
    folder,
    label,
    batchId,
    tabId: sourceTabId,
    gateTabIds: [tab.id],
    hosts: [hostOf(url), ...extraHosts],
  });
  if (batchId) {
    try {
      await groupFor(batchId, tab.windowId, tab.id, batchTotal);
    } catch (e) {
      console.warn('[DJ Track Hunter] tab group failed', e);
    }
  }
  return tab.id;
}

async function injectAutopilot(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['src/content/gate.js'] });
  } catch {
    // No host permission for this page (or a chrome:// page): the banner simply won't show.
  }
}

/** Close the gate tabs of a finished capture (if enabled), and tidy the batch's tab group title. */
export async function closeGateTabs(meta) {
  const settings = await getSettings();
  if (!settings.gates.closeAfterCapture || !meta?.gateTabIds?.length) return;
  setTimeout(() => {
    chrome.tabs.remove(meta.gateTabIds).catch(() => {});
  }, 2500);
}

/** Context for the gate content script; only tabs we opened as gates get one. */
export async function gateContext(tabId, url) {
  const cap = await captureForTab(tabId);
  if (!cap) return { active: false };
  const settings = await getSettings();
  const g = settings.gates;
  const oauthHost = hostOf(url);
  let redirectHost = '';
  try {
    const u = new URL(url);
    const r = u.searchParams.get('redirect_uri') || u.searchParams.get('redirect_url') || u.searchParams.get('return_to') || '';
    redirectHost = hostOf(r);
  } catch {
    redirectHost = '';
  }
  const gateHosts = settings.freeDomains.gate || [];
  const trusted = (h) => gateHosts.some((d) => h === d || h.endsWith(`.${d}`));
  return {
    active: true,
    label: cap.label,
    mode: g.mode,
    email: g.email,
    comment: g.comment,
    // Approve an OAuth consent screen only when it sends you back to a known gate service.
    approveOAuth: g.mode === 'auto' && g.autoApproveOAuth && !!redirectHost && trusted(redirectHost) && !trusted(oauthHost),
    isGateHost: trusted(oauthHost),
  };
}

export { armCapture, dropCapture, liveCaptures };

/**
 * Autopilot clicks are not user gestures, so Chrome's popup blocker would silently kill a gate's
 * "Connect with SoundCloud" OAuth window. While autopilot is on, allow popups on the configured
 * gate domains only (visible in chrome://settings/content/popups); remove the rules when it's off.
 */
export async function applyPopupPolicy() {
  if (!chrome.contentSettings?.popups) return;
  const settings = await getSettings();
  await chrome.contentSettings.popups.clear({});
  if (settings.gates.mode !== 'auto') return;
  for (const d of settings.freeDomains.gate || []) {
    for (const primaryPattern of [`https://${d}/*`, `https://*.${d}/*`]) {
      await chrome.contentSettings.popups.set({ primaryPattern, setting: 'allow' }).catch(() => {});
    }
  }
}

export function initGateListeners() {
  // Popups (window.open) and target=_blank tabs opened by a gate tab belong to that gate.
  // webNavigation catches window.open popups, which don't always carry openerTabId.
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
    addGateTab(d.sourceTabId, d.tabId);
  });
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.openerTabId != null) addGateTab(tab.openerTabId, tab.id);
  });
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.status !== 'complete') return;
    if (!(await captureForTab(tabId))) return;
    const settings = await getSettings();
    if (settings.gates.mode !== 'off') injectAutopilot(tabId);
  });
}
