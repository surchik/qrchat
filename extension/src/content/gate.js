// Gate autopilot. Injected by the service worker only into tabs it opened as download gates
// (and popups those tabs open). Shows a banner and, in "auto" mode, works through the gate:
// fills your email/comment, clicks the step buttons (connect / follow / repost / like /
// download), and approves an OAuth screen only when it redirects back to a known gate service.
// Buttons are found by visible text so it survives most redesigns; it never clicks the same
// element twice and stops after a fixed number of actions.

(async () => {
  if (window.__djhGate) return;
  window.__djhGate = true;

  let ctx;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'gate-context', url: location.href });
    ctx = res?.ok ? res.result : null;
  } catch {
    return;
  }
  if (!ctx?.active) return;

  const MAX_ACTIONS = 25;
  const STEP_MS = 1300;
  const RUN_MS = 4 * 60 * 1000;
  const clicked = new WeakSet();
  let actions = 0;
  const started = Date.now();

  // ---- banner ---------------------------------------------------------------------------------
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646; display: flex; gap: 10px; align-items: center;
        padding: 8px 14px; background: #7c3aed; color: #fff; font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 2px 10px rgba(0,0,0,.3); }
      .msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      button { border: 0; border-radius: 6px; padding: 4px 10px; background: rgba(255,255,255,.2); color: #fff; font: inherit; cursor: pointer; }
    </style>
    <div class="bar"><span class="msg"></span><button class="stop" type="button">Stop autopilot</button><button class="x" type="button">×</button></div>`;
  const msgEl = root.querySelector('.msg');
  let stopped = ctx.mode !== 'auto';
  root.querySelector('.stop').addEventListener('click', () => {
    stopped = true;
    say('Autopilot stopped. Finish the gate by hand; the download will still be captured.');
  });
  root.querySelector('.x').addEventListener('click', () => host.remove());
  (document.body || document.documentElement).appendChild(host);

  function say(text) {
    msgEl.textContent = `DJ Track Hunter · ${ctx.label || 'gate'} · ${text}`;
  }
  say(ctx.mode === 'auto' ? 'autopilot is working through this gate…' : 'complete this gate; the download will be captured and renamed automatically.');

  // ---- helpers --------------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/\bdisabled\b/i.test(el.className || '');
  const labelOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();

  function setValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickables() {
    return Array.from(document.querySelectorAll('button, a[href], [role="button"], input[type="submit"], input[type="button"], label'))
      .filter((el) => !host.contains(el) && visible(el) && enabled(el) && !clicked.has(el));
  }

  // Ordered: consent/OAuth first, then social steps, then the final download / continue.
  const OAUTH_RE = /^(connect( and continue)?|allow( access)?|authori[sz]e|agree|accept|continue|approve|yes,? continue)$/i;
  const STEP_RES = [
    /(connect|log ?in|sign ?in) (with|to) (soundcloud|spotify|youtube|instagram|twitter|x|facebook|google)/i,
    /^(follow|like|repost|subscribe|save|pre-?save|comment|share|add to library|support)( [\w .&'-]{1,40})?$/i,
    /^(unlock|unlock download|get (it|track|download|file)|download( now| track| file| free| wav| mp3| zip)?|free download|claim|continue|next|submit|done|finish|skip)$/i,
  ];
  // Never touch these, whatever the mode.
  const NEVER_RE = /(buy|purchase|checkout|pay|subscribe to (premium|pro)|upgrade|go\+|sign ?up|create account|delete|unfollow|log ?out|report|cancel)/i;

  function fillInputs() {
    let filled = false;
    for (const input of document.querySelectorAll('input[type="email"], input[name*="email" i], input[placeholder*="email" i]')) {
      if (visible(input) && !input.value && ctx.email) {
        setValue(input, ctx.email);
        filled = true;
      }
    }
    for (const ta of document.querySelectorAll('textarea, input[name*="comment" i], input[placeholder*="comment" i]')) {
      if (visible(ta) && !ta.value && ctx.comment) {
        setValue(ta, ctx.comment);
        filled = true;
      }
    }
    return filled;
  }

  function nextTarget() {
    const els = clickables();
    if (ctx.approveOAuth) {
      const ok = els.find((el) => OAUTH_RE.test(labelOf(el)) && !NEVER_RE.test(labelOf(el)));
      if (ok) return ok;
    }
    if (!ctx.isGateHost) return null; // on non-gate pages (Dropbox, OAuth not trusted) only guide
    for (const re of STEP_RES) {
      const el = els.find((e) => {
        const t = labelOf(e);
        return t && t.length <= 60 && re.test(t) && !NEVER_RE.test(t);
      });
      if (el) return el;
    }
    return null;
  }

  // Tell the service worker when a download-ish control is pressed (by us or by you), so the
  // file that follows is attributed to this gate even with ten gates open.
  document.addEventListener('click', (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest('a, button, [role="button"], input') : null;
    if (el && /download|get|unlock|claim|wav|mp3|zip/i.test(labelOf(el) + (el.getAttribute('href') || ''))) {
      chrome.runtime.sendMessage({ type: 'gate-armed' }).catch(() => {});
    }
  }, true);

  // ---- loop -----------------------------------------------------------------------------------
  while (!stopped && Date.now() - started < RUN_MS && actions < MAX_ACTIONS) {
    await sleep(STEP_MS);
    if (stopped) break;
    if (fillInputs()) say('filled in your details…');
    const el = nextTarget();
    if (!el) continue;
    clicked.add(el);
    actions += 1;
    say(`clicking “${labelOf(el).slice(0, 40)}” (${actions})…`);
    try {
      el.click();
    } catch {
      // ignore
    }
  }
  if (!stopped && ctx.mode === 'auto') {
    say(actions ? 'autopilot finished its steps. If no download started, finish the gate by hand.' : 'nothing to click automatically here. Finish the gate by hand; the file will still be captured.');
  }
})();
