// SoundCloud content script: injects a "hunt" button on tracks and shows progress toasts.
// Classic script (content scripts can't be ES modules); all logic is local.
//
// Injection strategy, most to least specific, because SoundCloud redesigns break selectors:
//  1. Known list-item / hero / player-bar selectors (classic layout).
//  2. Heuristic: any list item that holds exactly one track link and a play button.
//  3. A floating button on every track/set page, plus a right-click menu and Alt+Shift+D
//     (registered by the service worker), which need no DOM knowledge at all.

(() => {
  if (window.__djTrackHunter) return;
  window.__djTrackHunter = true;

  const RESERVED_ROOT = new Set([
    'discover', 'stream', 'search', 'you', 'upload', 'charts', 'settings', 'messages', 'notifications',
    'pages', 'terms-of-use', 'mobile', 'people', 'popular', 'jobs', 'imprint', 'connect', 'signin',
    'logout', 'tags', 'stations', 'feed', 'home', 'pro', 'creators', 'artists', 'for-artists', 'premium',
    'go', 'library', 'likes', 'following', 'followers', 'history', 'playlists', 'albums', 'insights',
    'login', 'signup', 'robots.txt', 'help', 'community-guidelines', 'apps', 'popular-tracks',
  ]);
  const RESERVED_SUB = new Set([
    'sets', 'likes', 'reposts', 'tracks', 'albums', 'followers', 'following', 'comments', 'popular-tracks',
    'spotlight', 'toptracks', 'recommended', 'stations', 'info', 'playlists', 'sounds', 'appears-on',
  ]);

  /** Classify a SoundCloud href as {url, kind:'track'|'set'} or null. */
  function classify(href) {
    let u;
    try {
      u = new URL(href, location.origin);
    } catch {
      return null;
    }
    if (u.hostname !== 'soundcloud.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    // System playlists ("Weekly", "Daily Drops") live under /discover/sets/<id>.
    if (parts[0] === 'discover' && parts[1] === 'sets' && parts.length === 3) return { url: `https://soundcloud.com/${parts.join('/')}`, kind: 'set' };
    if (parts.length < 2 || RESERVED_ROOT.has(parts[0].toLowerCase())) return null;
    const url = `https://soundcloud.com/${parts.join('/')}`;
    if (parts[1] === 'sets' && parts.length >= 3) {
      if (parts.length > 4 || (parts.length === 4 && !/^s-/.test(parts[3]))) return null;
      return { url, kind: 'set' };
    }
    if (RESERVED_SUB.has(parts[1].toLowerCase())) return null;
    if (parts.length === 2 || (parts.length === 3 && /^s-/.test(parts[2]))) return { url, kind: 'track' };
    return null;
  }

  // ---- buttons --------------------------------------------------------------------------------

  const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.23-1.42 1.42-4.23-4.24A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm1 1.75v4.1l1.55-1.55 1.06 1.06-3.36 3.37-3.37-3.37 1.06-1.06 1.56 1.55v-4.1h1.5Z"/></svg>';
  const STATE_TITLES = {
    idle: 'Hunt this track: DJDelivery first, then free/legit sources',
    busy: 'Hunting…',
    done: 'Downloaded',
    gate: 'Free-download gate opened',
    cart: 'In your Bandcamp cart',
    link: 'Store page opened',
    review: 'Possible matches: click to review',
    want: 'On your wantlist',
    error: 'Not found / error: click to retry',
  };
  const buttonsByUrl = new Map();

  function setButtonState(btn, state) {
    btn.dataset.state = state;
    btn.title = STATE_TITLES[state] || STATE_TITLES.idle;
    btn.setAttribute('aria-label', `DJ Track Hunter: ${btn.title}`);
    btn.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
  }

  function makeButton(getTarget, variant) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `djh-btn djh-${variant}`;
    btn.innerHTML = ICON; // static markup, no remote data
    setButtonState(btn, 'idle');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.state === 'busy') return; // already hunting this one
      const target = getTarget();
      if (!target) return;
      startHunt(target.url, btn);
    }, true);
    return btn;
  }

  function register(url, btn) {
    btn.dataset.url = url;
    if (!buttonsByUrl.has(url)) buttonsByUrl.set(url, new Set());
    buttonsByUrl.get(url).add(btn);
    pendingStatus.add(url);
  }

  function updateButtons(url, state) {
    const set = buttonsByUrl.get(url);
    if (!set) return;
    for (const btn of set) {
      if (btn.isConnected) setButtonState(btn, state);
      else set.delete(btn);
    }
    if (!set.size) buttonsByUrl.delete(url);
  }

  /** Drop buttons SoundCloud removed from the page (SPA navigation), so they can be collected. */
  function pruneButtons() {
    for (const [url, set] of buttonsByUrl) {
      for (const btn of set) if (!btn.isConnected && btn !== playerBtn) set.delete(btn);
      if (!set.size) buttonsByUrl.delete(url);
    }
  }

  // ---- injection --------------------------------------------------------------------------------

  const ITEM_SELECTORS = [
    '.soundList__item', '.searchList__item', '.trackList__item', '.compactTrackList__item',
    '.soundBadgeList__item', '.systemPlaylistTrackList__item', '.chartTracks__item',
    '.historicalPlays__item', '.lazyLoadingList__item', '.userStreamItem', '.trackItem',
  ].join(',');
  const TITLE_LINK_SELECTORS = ['a.soundTitle__title', 'a.trackItem__trackTitle', 'a.soundBadge__title', 'a.chartTrack__title', 'a.sound__coverArt', '[data-permalink-path]'];
  const ACTION_GROUP_SELECTORS = ['.soundActions .sc-button-group', '.trackItem__actions .sc-button-group', '.sc-button-group'];

  /** First match by selector priority (not document order) that belongs to this item, not a nested one. */
  function firstOwn(item, selectors) {
    for (const sel of selectors) {
      for (const el of item.querySelectorAll(sel)) {
        if (el.closest(ITEM_SELECTORS) === item) return el;
      }
    }
    return null;
  }

  function trackTargetIn(item) {
    const el = firstOwn(item, TITLE_LINK_SELECTORS);
    if (el) {
      const href = el.getAttribute('href') || el.getAttribute('data-permalink-path');
      const t = href && classify(href);
      if (t) return t;
    }
    return null;
  }

  function injectClassic() {
    for (const item of document.querySelectorAll(ITEM_SELECTORS)) {
      if (item.dataset.djh) continue;
      if (item.querySelector(':scope .djh-btn')) {
        item.dataset.djh = '1';
        continue;
      }
      const target = trackTargetIn(item);
      if (!target) continue;
      const btn = makeButton(() => target, 'inline');
      register(target.url, btn);
      const group = firstOwn(item, ACTION_GROUP_SELECTORS);
      if (group) group.appendChild(btn);
      else (firstOwn(item, TITLE_LINK_SELECTORS)?.parentElement || item).appendChild(btn);
      item.dataset.djh = '1';
    }
  }

  const PLAY_SELECTORS = 'button[aria-label*="play" i], button[title*="play" i], [class*="playButton" i], [class*="play-button" i], .sc-button-play';

  // Items that don't qualify are re-examined a few times (content can arrive late), then skipped.
  const heuristicTries = new WeakMap();
  const heuristicSig = new WeakMap();

  function injectHeuristic() {
    const root = document.querySelector('main, #content, #app') || document.body;
    for (const item of root.querySelectorAll('li, article, [role="listitem"]')) {
      if (item.dataset.djh) continue;
      const tries = heuristicTries.get(item) || 0;
      if (tries >= 3) continue;
      if (item.querySelector('.djh-btn') || item.closest('[data-djh]')) continue;
      // Count a try only when the item's content changed since last time (late-loading rows).
      const sig = item.childElementCount * 1000 + (item.textContent || '').length;
      if (heuristicSig.get(item) === sig) continue;
      heuristicSig.set(item, sig);
      heuristicTries.set(item, tries + 1);
      const links = new Map();
      for (const a of item.querySelectorAll('a[href]')) {
        const t = classify(a.getAttribute('href'));
        if (t && a.textContent.trim()) links.set(t.url, { t, a });
        if (links.size > 1) break;
      }
      if (links.size !== 1 || !item.querySelector(PLAY_SELECTORS)) continue;
      const [{ t, a }] = links.values();
      const btn = makeButton(() => t, 'inline');
      register(t.url, btn);
      a.insertAdjacentElement('afterend', btn);
      item.dataset.djh = '1';
    }
  }

  function currentPageTarget() {
    return classify(location.href);
  }

  function playingTarget() {
    const a = document.querySelector('.playbackSoundBadge__titleLink, [class*="playbackSoundBadge"] a[href]');
    return a ? classify(a.getAttribute('href')) : null;
  }

  function injectHero() {
    const page = currentPageTarget();
    if (!page) return;
    const hero = document.querySelector('.listenEngagement__footer .sc-button-group, .fullListenHero .sc-button-group, .listenDetails .sc-button-group');
    if (!hero || hero.querySelector('.djh-btn')) return;
    const btn = makeButton(() => currentPageTarget(), 'inline');
    register(page.url, btn);
    hero.appendChild(btn);
  }

  let playerBtn = null;
  function injectPlayer() {
    const host = document.querySelector('.playbackSoundBadge__actions, .playControls__soundBadge');
    if (!host) return;
    if (!playerBtn || !playerBtn.isConnected) {
      playerBtn = makeButton(playingTarget, 'player');
      host.appendChild(playerBtn);
    }
    const t = playingTarget();
    if (t && playerBtn.dataset.url !== t.url) {
      buttonsByUrl.get(playerBtn.dataset.url)?.delete(playerBtn);
      register(t.url, playerBtn);
      setButtonState(playerBtn, 'idle');
    }
  }

  // ---- floating button + toasts (shadow DOM keeps SoundCloud's CSS out) -----------------------------

  const host = document.createElement('div');
  host.id = 'djh-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { position: fixed; z-index: 2147483000; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #f4f4f5; }
      .fab-wrap { right: 18px; bottom: 72px; }
      .toasts { pointer-events: none; left: 18px; bottom: 72px; display: flex; flex-direction: column-reverse; gap: 8px; width: min(380px, calc(100vw - 36px)); }
      .fab { display: none; align-items: center; gap: 6px; padding: 9px 14px; border-radius: 999px; border: 0; cursor: pointer;
        background: #7c3aed; color: #fff; font-weight: 600; font-size: 13px; box-shadow: 0 6px 18px rgba(0,0,0,.35); }
      .fab:hover { background: #6d28d9; }
      .fab.show { display: inline-flex; }
      .card { pointer-events: auto; background: #18181b; border: 1px solid #3f3f46; border-radius: 10px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
      .head { display: flex; align-items: center; gap: 8px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #a1a1aa; }
      .busy .dot { background: #a78bfa; animation: pulse 1s infinite; }
      .done .dot { background: #22c55e; } .gate .dot { background: #38bdf8; } .cart .dot { background: #f59e0b; }
      .link .dot { background: #38bdf8; } .review .dot { background: #fb923c; } .want .dot { background: #c084fc; } .error .dot { background: #ef4444; }
      @keyframes pulse { 50% { opacity: .3; } }
      .label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
      .x { background: none; border: 0; color: #a1a1aa; cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; }
      .msg { margin-top: 4px; color: #d4d4d8; }
      .notes { margin: 6px 0 0; padding: 0; list-style: none; color: #a1a1aa; font-size: 12px; }
      .cands { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
      .cand { display: flex; gap: 8px; align-items: center; background: #27272a; border-radius: 8px; padding: 6px 8px; }
      .cand .txt { flex: 1; min-width: 0; }
      .cand .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cand .s { color: #a1a1aa; font-size: 11px; }
      .btn { border: 0; border-radius: 6px; padding: 5px 9px; cursor: pointer; font-weight: 600; font-size: 12px; background: #7c3aed; color: #fff; white-space: nowrap; }
      .btn.secondary { background: #3f3f46; }
      .actions { margin-top: 8px; display: flex; gap: 6px; justify-content: flex-end; }
    </style>
    <div class="wrap fab-wrap"><button class="fab" type="button">${ICON}<span>Hunt</span></button></div>
    <div class="wrap toasts" role="status" aria-live="polite"></div>`;
  const fab = shadow.querySelector('.fab');
  const toasts = shadow.querySelector('.toasts');
  const inFlight = new Set();
  fab.addEventListener('click', () => {
    const t = currentPageTarget();
    if (t && !inFlight.has(t.url)) startHunt(t.url, null);
  });

  function ensureHost() {
    if (!host.isConnected && document.body) document.body.appendChild(host);
  }

  function updateFab() {
    const t = currentPageTarget();
    fab.classList.toggle('show', !!t);
    fab.querySelector('span').textContent = t?.kind === 'set' ? 'Hunt whole set' : 'Hunt';
  }

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const cards = new Map();
  const ACTION_LABEL = { download: 'Download', gate: 'Open gate', 'free-page': 'Get free', 'bandcamp-page': 'Bandcamp', cart: 'Add to cart', link: 'Open' };

  function renderCard(msg) {
    let card = cards.get(msg.entryId);
    if (!card) {
      card = h('div', { class: 'card' });
      cards.set(msg.entryId, card);
      toasts.append(card);
    }
    card.className = `card ${msg.state}`;
    clearTimeout(card._timer);
    const close = () => {
      clearTimeout(card._timer);
      card.remove();
      cards.delete(msg.entryId);
    };
    const kids = [
      h('div', { class: 'head' }, h('span', { class: 'dot' }), h('span', { class: 'label', title: msg.label }, msg.label), h('button', { class: 'x', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: close }, '×')),
      h('div', { class: 'msg' }, msg.message || ''),
    ];
    if (msg.final && msg.notes?.length && msg.state !== 'done') {
      kids.push(h('ul', { class: 'notes' }, msg.notes.map((n) => h('li', {}, n))));
    }
    // Candidates stay visible after a failed pick so you can try another one.
    if ((msg.state === 'review' || (msg.state === 'error' && msg.final)) && msg.candidates?.length) {
      kids.push(h('div', { class: 'cands' }, msg.candidates.map((c) => h('div', { class: 'cand' },
        h('div', { class: 'txt' },
          h('div', { class: 't', title: `${c.artist ? `${c.artist} - ` : ''}${c.title}${c.version ? ` (${c.version})` : ''}` }, `${c.artist ? `${c.artist} - ` : ''}${c.title}${c.version ? ` (${c.version})` : ''}`),
          h('div', { class: 's' }, `${c.sourceLabel} · ${Math.round(c.score * 100)}%${c.detail ? ` · ${c.detail}` : ''}`)),
        h('button', {
          class: 'btn',
          onclick: (ev) => {
            ev.currentTarget.disabled = true;
            ev.currentTarget.textContent = '…';
            send({ type: 'act', entryId: msg.entryId, cid: c.cid });
          },
        }, ACTION_LABEL[c.kind] || 'Go')))));
      kids.push(h('div', { class: 'actions' }, h('button', {
        class: 'btn secondary',
        onclick: async (ev) => {
          ev.currentTarget.disabled = true;
          const res = await send({ type: 'want', entryId: msg.entryId });
          if (res?.ok) {
            updateButtons(msg.scUrl, 'want');
            close();
          } else {
            ev.currentTarget.textContent = 'Couldn’t wantlist';
          }
        },
      }, 'Wantlist it')));
    }
    if (msg.owned) {
      kids.push(h('div', { class: 'actions' }, h('button', { class: 'btn secondary', onclick: () => { close(); startHunt(msg.scUrl, null, true); } }, 'Search again anyway')));
    }
    card.replaceChildren(...kids);
    if (msg.final && ['done', 'cart', 'gate', 'link', 'want'].includes(msg.state)) card._timer = setTimeout(close, 9000);
  }

  // ---- messaging ------------------------------------------------------------------------------------

  let orphaned = false;
  /** The extension was reloaded/updated: this copy of the script can no longer talk to it. */
  function teardown() {
    if (orphaned) return;
    orphaned = true;
    observer?.disconnect();
    document.querySelectorAll('.djh-btn').forEach((b) => b.remove());
    host.remove();
  }

  async function send(msg) {
    if (orphaned || !chrome.runtime?.id) {
      teardown();
      return { ok: false, error: 'extension reloaded' };
    }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (/context invalidated/i.test(String(e?.message))) teardown();
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function startHunt(url, btn, force = false) {
    if (btn) setButtonState(btn, 'busy');
    updateButtons(url, 'busy');
    inFlight.add(url);
    const res = await send({ type: 'hunt', url, force });
    if (!res?.ok) {
      inFlight.delete(url);
      if (btn) setButtonState(btn, 'error');
      updateButtons(url, 'error');
      if (!orphaned) {
        ensureHost();
        renderCard({ entryId: `local-${url}`, scUrl: url, label: url.replace('https://soundcloud.com/', ''), state: 'error', message: res?.error || 'Could not start the hunt', final: true });
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'hunt-progress') {
      if (msg.scUrl) updateButtons(msg.scUrl, msg.state);
      // The URL the button was registered under may differ from the canonical permalink.
      if (msg.reqUrl && msg.reqUrl !== msg.scUrl) updateButtons(msg.reqUrl, msg.state);
      if (msg.final) {
        inFlight.delete(msg.scUrl);
        if (msg.reqUrl) inFlight.delete(msg.reqUrl);
      }
      if (!msg.silent) {
        ensureHost();
        renderCard(msg);
      }
      return false;
    }
    if (msg?.type === 'get-current-track') {
      const t = playingTarget() || currentPageTarget();
      sendResponse({ url: t?.url || null });
      return false;
    }
    return false;
  });

  // Ask the background which of the visible tracks we already have / wantlisted.
  const pendingStatus = new Set();
  let statusTimer = null;
  function flushStatus() {
    statusTimer = null;
    const urls = [...pendingStatus];
    pendingStatus.clear();
    if (!urls.length) return;
    send({ type: 'status-for-urls', urls }).then((res) => {
      if (!res?.ok) return;
      const map = { downloaded: 'done', downloading: 'busy', cart: 'cart', gate: 'gate', review: 'review', want: 'want' };
      for (const [url, status] of Object.entries(res.result || {})) updateButtons(url, map[status] || 'idle');
    });
  }

  // ---- main loop ----------------------------------------------------------------------------------

  let lastHref = '';
  function scan() {
    ensureHost();
    if (location.href !== lastHref) {
      lastHref = location.href;
      for (const [id, c] of cards) {
        if (!c.classList.contains('busy') && !c.classList.contains('review') && !c.classList.contains('gate')) {
          clearTimeout(c._timer);
          c.remove();
          cards.delete(id);
        }
      }
      pruneButtons();
    }
    try {
      injectClassic();
      injectHeuristic();
      injectHero();
      injectPlayer();
    } catch (e) {
      console.debug('[DJ Track Hunter] injection error', e);
    }
    updateFab();
    if (pendingStatus.size && !statusTimer) statusTimer = setTimeout(flushStatus, 300);
  }

  let scanTimer = null;
  // Ignore mutations that can't add tracks: our own UI and the player's ticking time display.
  const IGNORE = '#djh-root, .playbackTimeline, [class*="playbackTimeline"]';
  var observer = new MutationObserver((records) => {
    if (orphaned) return;
    if (records.every((r) => r.target instanceof Element && r.target.closest(IGNORE))) return;
    if (!scanTimer) scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 350);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
