import { extractRows, parseBandcampSearch, parseBandcampTralbum } from '../lib/extract.js';

const OPS = {
  'pool-rows': (doc, msg) => extractRows(doc, msg.cfg, msg.baseUrl),
  'bandcamp-search': (doc) => parseBandcampSearch(doc),
  'bandcamp-tralbum': (doc) => parseBandcampTralbum(doc),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  try {
    const op = OPS[msg.op];
    if (!op) throw new Error(`Unknown parse op ${msg.op}`);
    const doc = new DOMParser().parseFromString(msg.html || '', 'text/html');
    sendResponse({ result: op(doc, msg) });
  } catch (e) {
    sendResponse({ error: String(e?.message || e) });
  }
  return false;
});
