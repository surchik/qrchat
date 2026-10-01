# Roadmap

Ordered by value to a working DJ divided by build effort. Effort: S = under a day, M = a few days, L = a week or more.

## Done in v0.1

- Button on SoundCloud tracks (list items, track page, player bar), floating button, right-click, Alt+Shift+D, popup paste box
- DJDelivery search + download through your session (config-driven adapter, 3 fetch modes, login detection, preferred-version picking, pacing + daily cap)
- Artist-enabled SoundCloud downloads; free-gate / file-host / Bandcamp links on the track; same track on other SoundCloud uploads
- Bandcamp: free/NYP → free download page; paid → auto add-to-cart
- Gate capture: the file a gate page downloads is attached to the hunt, renamed and filed
- Whole-set hunting (playlists/albums), wantlist with periodic DJDelivery re-check + notification + auto-download
- "Already have it" badges on SoundCloud, history, CSV export, settings backup, Discovery mode for configuring DJDelivery

## Next: highest leverage

| # | Feature | Why it matters | Effort |
|---|---|---|---|
| 1 | **DJDelivery preset** | Replace the manual setup with a tested adapter (needs one Discovery log + one search response from you). | S |
| 2 | **Fake-lossless detector** | Run every downloaded file through an FFT (OfflineAudioContext) and flag WAV/AIFF files whose spectrum cuts off around 16 kHz or 19–20 kHz, the usual sign of upsampled MP3. Free gates and some pools serve these more often than people think. Tag or rename them so you never play a transcode on a big system. | M |
| 3 | **Library dedupe** | Import a rekordbox XML / Traktor NML / Serato crate, or pick your music folder (File System Access API), and mark tracks you already own *before* spending a pool download or Bandcamp money. History only knows what this extension downloaded. | M |
| 4 | **Mix tracklist hunting** | Parse tracklists from a mix's description/comments ("12:34 Artist - Title") and batch-hunt every ID. Mixes are where most DJs discover music; this turns one click into a crate. | S–M |
| 5 | **Tagging on arrival** | Write artist / title / mix / label / genre / BPM / key / artwork (from the pool or SoundCloud) and a comment with the source URL. Prefer AIFF over WAV, because WAV tag support varies across DJ software. | M |
| 6 | **Session crate export** | After each hunting session, write a rekordbox-XML (or M3U) playlist "Hunted YYYY-MM-DD" so new tracks land in a playlist, not just a folder. | S |
| 7 | **Preview before committing** | Play the pool's or Bandcamp's preview inside the candidate list to confirm the version (extended vs. radio, the right remix) without opening tabs. | S |
| 8 | **Likes / reposts / artist tracks batch** | Same as sets, but for your Likes page, a user's Tracks tab, or a date range ("everything I liked this week"). Paced so pool limits hold. | S |

## Then

| # | Feature | Notes | Effort |
|---|---|---|---|
| 9 | **More pools** | Turn the single DJDelivery config into a list (BPM Supreme, DJcity, ZipDJ, Digital DJ Pool…), each with priority and its own cap. The adapter is already generic. | S per pool |
| 10 | **Paid store fallbacks** | Beatport / Traxsource / Juno search + add-to-cart, only if you open accounts there. Beats ending at "not found" for releases that never hit a pool. | M |
| 11 | **Promo inbox source** | If you receive label promos (Inflyte-style services), search them before buying anything. | M |
| 12 | **Budget guard** | Monthly Bandcamp spend cap, running cart total in the popup, "cart has 14 items / €23" nag. | S |
| 13 | **Hunt from anywhere** | The same button on YouTube, Instagram, Beatport charts, 1001Tracklists, Spotify playlists, Shazam export. The pipeline only needs artist/title, so most of the work is per-site injection. | M |
| 14 | **Coverage analytics** | Hit rate per source over time. Tells you whether DJDelivery actually covers your taste or whether you're paying for a pool that hits a small share of your clicks. Data for keep/cancel decisions on subscriptions. | S |
| 15 | **Key/BPM-aware toast** | Show Camelot key + BPM from pool data before downloading; optional filter "only auto-download 120–128 BPM". | S |
| 16 | **Sync across machines** | History + wantlist via a small backend or a Google Drive file (chrome.storage.sync is too small). | M |

## Deliberately not planned

- **SoundCloud stream ripping**: low-bitrate lossy audio, against SoundCloud's terms, and the reason most "SoundCloud downloader" extensions get pulled.
- **Pirate "free WAV" aggregators**: legal exposure, malware risk, and much of what they serve is transcoded.
- **Automating gate social actions** (mass follow/repost/unfollow): that's how SoundCloud and Spotify accounts get flagged. The extension opens the gate; you click.
- **Auto-buy**: one wrong-remix match costs money. Cart + human checkout is the right boundary.
