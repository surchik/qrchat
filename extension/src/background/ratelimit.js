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
  return new Date().toISOString().slice(0, 10);
}

/** Count one download against the daily cap; throws once the cap is reached. */
export async function takeDailyQuota(key, cap) {
  if (!cap) return;
  const { quotas = {} } = await chrome.storage.local.get('quotas');
  const day = today();
  const k = `${day}:${key}`;
  const used = quotas[k] || 0;
  if (used >= cap) throw new Error(`Daily cap reached for ${key} (${cap}). Raise it in Settings if you're sure.`);
  for (const old of Object.keys(quotas)) if (!old.startsWith(day)) delete quotas[old];
  quotas[k] = used + 1;
  await chrome.storage.local.set({ quotas });
}
