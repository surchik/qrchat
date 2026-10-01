// Settings schema, defaults and persistence (chrome.storage.local).

export const SOURCE_META = {
  djdelivery: { label: 'DJDelivery', description: 'Your record pool (logged-in session).' },
  'sc-original': { label: 'SoundCloud download', description: 'The artist-enabled download button on the track itself.' },
  'sc-links': { label: 'Free links on the track', description: 'Hypeddit/ToneDen gates, Dropbox/Drive links, Bandcamp links in the buy link or description.' },
  'sc-alt': { label: 'Other SoundCloud uploads', description: 'Same track uploaded by the artist/label/promo channel with a free download.' },
  bandcamp: { label: 'Bandcamp', description: 'Free / name-your-price downloads, otherwise add to cart.' },
};

export const DEFAULTS = {
  version: 1,
  sourceOrder: ['djdelivery', 'sc-original', 'sc-links', 'sc-alt', 'bandcamp'],
  sources: {
    djdelivery: { enabled: true },
    'sc-original': { enabled: true },
    'sc-links': { enabled: true },
    'sc-alt': { enabled: true },
    bandcamp: { enabled: true },
  },
  autoAct: true,
  matching: { autoThreshold: 0.82, reviewThreshold: 0.55 },
  // 'cart' = add paid Bandcamp matches to the cart, 'link' = only open the page.
  paidAction: 'cart',
  files: {
    folder: 'DJ Track Hunter/{source}',
    filename: '{artist} - {title}{ (mix)}',
  },
  wantlist: {
    enabled: true,
    intervalHours: 12,
    maxPerRun: 15,
    autoDownload: true,
    sources: ['djdelivery'],
  },
  djdelivery: {
    label: 'DJDelivery',
    baseUrl: 'https://djdelivery.com',
    // background: fetch from the extension with your cookies.
    // tab-fetch: fetch from inside a DJDelivery tab (for sites that use a token in localStorage).
    // tab-render: open the search page in a background tab and read the rendered DOM (JS-heavy sites).
    transport: 'background',
    format: 'html', // 'html' | 'json'
    searchUrl: '', // e.g. https://djdelivery.com/search?q={query}
    queryTemplates: ['{artist} {title}', '{title}'],
    loginUrlIncludes: '/login',
    loginSelector: 'input[type="password"]',
    html: { row: '', artist: '', title: '', version: '', id: '', download: '', bpm: '', key: '', genre: '', isrc: '' },
    json: { itemsPath: '', artist: '', title: '', version: '', id: '', download: '', bpm: '', key: '', genre: '', isrc: '' },
    download: { urlTemplate: '', method: 'GET', resolveJsonPath: '' },
    auth: { localStorageKey: '', jsonPath: '', header: 'Authorization', prefix: 'Bearer ' },
    versionPrefer: ['Extended', 'Original', 'Intro Dirty', 'Dirty', 'Main', 'Intro Clean', 'Clean', 'Radio'],
    versionAvoid: ['Acapella', 'Instrumental', 'Quick Hit', 'Short', 'Transition', 'Hype'],
    minIntervalMs: 3500,
    dailyDownloadCap: 150,
  },
  freeDomains: {
    // Heuristic starting lists; edit them in Settings as you meet new gate services.
    gate: ['hypeddit.com', 'toneden.io', 'hive.co'],
    filehost: ['dropbox.com', 'drive.google.com', 'docs.google.com', 'wetransfer.com', 'we.tl', 'mediafire.com', 'mega.nz', 'box.com'],
    hub: ['linktr.ee', 'lnk.to', 'ffm.to', 'smarturl.it', 'distrokid.com', 'beacons.ai'],
    paidstore: ['beatport.com', 'traxsource.com', 'junodownload.com', 'beatsource.com', 'music.apple.com', 'itunes.apple.com', 'amazon.com'],
  },
  discovery: { enabled: false },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge `over` onto `base`; arrays and scalars in `over` replace. */
export function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = deepMerge(structuredClone(DEFAULTS), settings || {});
  // New sources added in later versions get appended to a saved order.
  for (const id of Object.keys(SOURCE_META)) if (!merged.sourceOrder.includes(id)) merged.sourceOrder.push(id);
  merged.sourceOrder = merged.sourceOrder.filter((id) => SOURCE_META[id]);
  return merged;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export function poolConfigured(cfg) {
  if (!cfg?.searchUrl) return false;
  if (cfg.format === 'json') return !!(cfg.json?.itemsPath != null && cfg.json?.title);
  return !!(cfg.html?.row && cfg.html?.title);
}
