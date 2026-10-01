// Per-host pacing and daily download caps, so a busy session looks like a person
// clicking rather than a scraper (and stays under pool download limits).

const nextSlot = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until at least `minMs` (+ jitter) has passed since the previous call with this key. */
export async function throttle(key, minMs) {
  const now = Date.now();
  const jitter = Math.round(Math.random() * minMs * 0.3);
  const slot = Math.max(now, nextSlot.get(key) || 0);
  nextSlot.set(key, slot + minMs + jitter);
  if (slot > now) await sleep(slot - now);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let quotaChain = Promise.resolve();
function serialized(fn) {
  const run = quotaChain.then(fn, fn);
  quotaChain = run.catch(() => {});
  return run;
}

/**
 * Count one download against the local-day cap; throws once the cap is reached.
 * Returns a refund() to call if the download then fails to start.
 */
export function takeDailyQuota(key, cap) {
  return serialized(async () => {
    const noop = async () => {};
    if (!cap) return noop;
    const { quotas = {} } = await chrome.storage.local.get('quotas');
    const day = today();
    const k = `${day}:${key}`;
    const used = quotas[k] || 0;
    if (used >= cap) throw new Error(`Daily cap reached for ${key} (${cap}). Raise it in Settings if you're sure.`);
    for (const old of Object.keys(quotas)) if (!old.startsWith(day)) delete quotas[old];
    quotas[k] = used + 1;
    await chrome.storage.local.set({ quotas });
    return () => serialized(async () => {
      const { quotas: q = {} } = await chrome.storage.local.get('quotas');
      if (q[k]) q[k] -= 1;
      await chrome.storage.local.set({ quotas: q });
    });
  });
}
