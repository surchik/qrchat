// "Discovery mode": while you browse DJDelivery normally, log the page/XHR requests it makes
// (method, URL, status, content type; never bodies or cookies) so its search and download
// endpoints can be identified and plugged into Settings.

const CAP = 400;
let enabled = false;
let buffer = [];
let flushTimer = null;

export function setDiscoveryEnabled(v) {
  enabled = !!v;
}

export function logRequest(details) {
  if (!enabled || details.tabId < 0) return;
  const ct = (details.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  // Skip static assets; keep documents, API calls and file downloads.
  if (/^(image|font)\/|text\/css|javascript/i.test(ct)) return;
  buffer.push({ t: Date.now(), method: details.method, url: details.url, status: details.statusCode, type: details.type, contentType: ct });
  if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

async function flush() {
  flushTimer = null;
  const items = buffer;
  buffer = [];
  const { discovery = [] } = await chrome.storage.local.get('discovery');
  const next = discovery.concat(items).slice(-CAP);
  await chrome.storage.local.set({ discovery: next });
}

export async function getLog() {
  const { discovery = [] } = await chrome.storage.local.get('discovery');
  return discovery;
}

export async function clearLog() {
  buffer = [];
  await chrome.storage.local.set({ discovery: [] });
}
