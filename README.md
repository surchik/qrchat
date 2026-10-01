# DJ Track Hunter (Chrome extension, MV3)

One click on a SoundCloud track:

1. **DJDelivery** (your record pool, using your logged-in browser session) → download the best-matching version, renamed and filed.
2. If DJDelivery doesn't have it → **the artist's own SoundCloud download button** (original file).
3. → **Free links on the track**: Hypeddit / ToneDen gates, Dropbox / Drive / WeTransfer links, Bandcamp links found in the buy link or description. The gate opens in a **new tab right next to SoundCloud** so you can pass it (or the autopilot does, see below); the file it downloads is captured, renamed and filed automatically, then the gate tab closes.
4. → **Other SoundCloud uploads** of the same track (artist, label or premiere channel) that have downloads or free links.
5. → **Bandcamp**: free / name-your-price → opens the free download; paid → **added to your cart automatically**.
6. Nothing found → **wantlisted**; DJDelivery is re-checked every 12 h and the track downloads itself when it appears.

Unsure matches (a different remix, an acapella, a similar title) are **never** downloaded automatically. You get a short candidate list instead.

```
SoundCloud click ─► resolve track (api-v2) ─► parse "Artist - Title (Mix)" ─► sources in priority order
                                                                              │
             confident match ◄─────────────── fuzzy match + version rules ◄───┘
               │                │                  │                   │
          download (pool,   open gate +       add to Bandcamp     review list /
          SC original)      capture file      cart (background)   wantlist
```

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder.
2. Stay logged in to **soundcloud.com**, **DJDelivery** and **Bandcamp** in the same Chrome profile. The extension never sees or stores passwords; it rides your existing sessions.
3. Settings open on install. **DJDelivery must be configured once** (next section).

Ways to trigger a hunt: the violet button next to each track; the floating **Hunt** button on any track page (or **Hunt whole set** on a playlist); right-click any SoundCloud link → *Hunt this track*; **Alt+Shift+D** hunts what's playing; or paste a link into the toolbar popup.

## Configuring DJDelivery (one-time, about 5 minutes)

I couldn't see DJDelivery while building this: it wasn't reachable from my build environment and it isn't indexed anywhere I could search. So the pool adapter is **driven by configuration**, not hard-coded:

1. Settings → Diagnostics → enable **Discovery mode** → Save.
2. In another tab, search DJDelivery for any track and download one file.
3. Back in Settings → **Discovery log**: find the search request and the download request.
   * Search request is a page (HTML) → set **Search URL** (put `{query}` where the search text goes), **Search response = HTML**, then the CSS selectors for the result row, artist, title, version and download link (`a.download@href` reads an attribute). Use DevTools → *Inspect* on a result row to find them.
   * Search request returns JSON → set **Search response = JSON**, copy one response body from DevTools → Network into **Auto-map JSON** → *Detect mapping*.
   * Download goes through an API that answers `{"url": "https://cdn…"}` → set **Signed URL path** (e.g. `url`).
4. **Test DJDelivery search** shows parsed rows with match scores. When those look right, it works.

**Fetch method:** *Background* works for normal cookie-based sites. *From a DJDelivery tab* is for single-page apps that keep an API token in `localStorage`. *Render page in a hidden tab* is the last resort for sites that only build results with JavaScript.

If you send me the Discovery log (it holds URLs only, no cookies or bodies) plus one search response, I can ship a preset so nobody has to do this by hand.

## Download gates

* **Single track:** the gate opens in a new, focused tab next to your SoundCloud tab.
* **Whole set:** every gate opens at once in a purple **“Gates”** tab group (in the background), so you can work through them or let the autopilot run.
* **Autopilot** (Settings → Download gates, default *Auto*): a banner on the gate page shows what it's doing. It fills your gate email (and comment, if you set one), clicks the connect / follow / like / repost / download steps, and approves a SoundCloud/Spotify login screen **only if that screen sends you back to a known gate domain** (so a look-alike page can't harvest an approval). It never clicks buy / subscribe / sign-up / unfollow, stops after 25 actions, and has a *Stop autopilot* button. *Guide* mode shows the banner only; *Off* just opens the tab.
* Because autopilot clicks aren't user gestures, Chrome would block the gate's login popup. While autopilot is on, the extension allows popups **only on the gate domains in your list** (visible in `chrome://settings/content/popups`); switching autopilot off removes those rules.
* Downloads are matched to the right gate by the tab they came from, so ten gates on hypeddit.com at once still produce ten correctly named files. A download with no link to a pending gate (your invoice, a podcast) is left alone.
* Risk you accepted: automated follows/reposts are exactly what SoundCloud and Spotify look for when flagging accounts. Keep set sizes reasonable, or use *Guide* mode for big batches.

## Files

Downloads land in `Downloads/DJ Track Hunter/<source>/Artist - Title (Mix).ext` (both templates are editable). Chrome extensions can only write inside the Downloads folder. To feed your DJ software, point its import or watch-folder at that path.

## What is verified and what isn't

| Part | Status |
|---|---|
| Matching / title parsing (remixer and version rules, pool flavours, feat., promo junk, look-alike titles and artists) | 85 unit tests (`npm test`), including ~50 regression cases from an adversarial review |
| Core pipeline in real Chromium: button injection, service worker, offscreen parsing, download renaming, Bandcamp cart, sets, wantlist re-check, popup, settings | 13 end-to-end checks (`tests/e2e/run-e2e.mjs`) against **mock** sites |
| Gates: new tab placement, autopilot through an OAuth popup, tab closing, 3 concurrent gates in a tab group with out-of-order downloads, refusing an untrusted OAuth screen, guide mode | 7 end-to-end checks (`tests/e2e/gates-e2e.mjs`) |
| Edge cases: JSON pool + signed URLs, logged-out pool, daily cap, review pick from the toast, artist SoundCloud download, unrelated downloads untouched, double clicks, bad links, service worker killed mid-gate | 9 end-to-end checks (`tests/e2e/robustness-e2e.mjs`) |
| SoundCloud api-v2 calls (`resolve`, `search/tracks`, `tracks/{id}/download` → `redirectUri`, `oauth_token` cookie, client_id discovery) | Same endpoints and auth that yt-dlp's SoundCloud extractor uses. Not exercised live from the build environment. |
| SoundCloud button placement | Classic-layout selectors + a layout-agnostic heuristic + a floating button, right-click menu and hotkey that don't depend on the DOM. SoundCloud's 2026 track-page redesign broke other extensions' selectors, so expect the inline buttons to need a selector update eventually. The fallbacks keep working. |
| Bandcamp search / track data / add-to-cart | Long-standing markup (`.result-items li`, `script[data-tralbum]`, "Buy Digital Track" → "Add to cart"). Tested on mocks only. Text-based button finding, and on failure the tab is shown to you. |
| DJDelivery | Configuration-driven. Unknown until configured (see above). |

## Rules this extension follows on purpose

* **No stream ripping.** SoundCloud streams are low-bitrate lossy files and not fit for a club system; ripping them also breaks SoundCloud's terms.
* **Free sources are artist-sanctioned only**: download gates, artist-enabled downloads, links the artist posted, Bandcamp free/NYP. Pirate "free WAV" aggregators are not supported. Beyond the legal exposure, much of what they serve is upsampled MP3.
* **Pool pacing**: searches are throttled (default 3.5 s plus jitter) and there is a daily download cap (default 150). Many pools prohibit automated access and ban accounts that download in bursts. Keep the cap under your pool's own limit.
* **No auto-buy**: paid Bandcamp matches go into the cart; you check out.

## Development

```
npm test            # unit tests (Node ≥ 20, no dependencies)
npm run test:e2e    # 3 Playwright + Chromium end-to-end suites against mock sites
npm run test:all    # both
npm run icons       # regenerate icons
npm run zip         # package extension/ for the Chrome Web Store
```

```
extension/
  manifest.json
  src/background/   sw.js (listeners + message router), pipeline.js (the hunt), downloads.js (naming + gate capture),
                    gates.js (gate tabs, tab groups, popup tracking, autopilot injection),
                    parse.js (offscreen DOMParser bridge), ratelimit.js, discovery.js
  src/adapters/     soundcloud.js, pool.js (DJDelivery, config-driven), bandcamp.js
  src/lib/          normalize.js, match.js, jsonpath.js, extract.js, freelinks.js, settings.js, store.js
  src/content/      soundcloud.js + .css (buttons, floating button, toasts in shadow DOM), gate.js (gate autopilot)
  src/offscreen/    HTML parsing for the service worker
  src/ui/           popup, options
tests/              unit tests + e2e/run-e2e.mjs
```

See [ROADMAP.md](ROADMAP.md) for what to build next.

## Permissions, and why

`downloads` (save and name files) · `cookies` (your SoundCloud login token) · `scripting` (Bandcamp cart, pool tabs, gate autopilot) · `webRequest` (SoundCloud client id, Discovery log) · `webNavigation` + `tabGroups` (follow gate popups, group batch gates) · `contentSettings` (allow popups on gate domains while autopilot is on) · `offscreen` (parse HTML) · `alarms` + `notifications` (wantlist) · `contextMenus` · `storage` + `unlimitedStorage` (history). Host access is limited to SoundCloud, DJDelivery, Bandcamp and the gate services; other pool domains are requested at runtime.
