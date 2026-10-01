const $ = (s) => document.querySelector(s);

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || 'No response');
  return res.result;
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

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const ACTION_LABEL = { download: 'Download', gate: 'Open gate', 'free-page': 'Get free', 'bandcamp-page': 'Bandcamp', cart: 'Add to cart', link: 'Open' };

function detailFor(e) {
  if (e.status === 'downloaded' || e.status === 'owned') return (e.file || '').split(/[\\/]/).pop() || 'Downloaded';
  if (e.status === 'batch') return e.summary || 'Set in progress…';
  if (e.message && e.status !== 'downloading') return e.message;
  if (e.chosen) return `${e.chosen.sourceLabel}${e.chosen.detail ? ` · ${e.chosen.detail}` : ''}`;
  if (e.status === 'failed') return e.error || 'Download failed';
  return (e.notes || []).slice(-1)[0] || '';
}

async function render() {
  const [history, want] = await Promise.all([send({ type: 'list-history', limit: 40 }), send({ type: 'list-want' })]);
  const missing = want.filter((w) => w.status === 'missing').length;
  $('#want-count').textContent = `Wantlist: ${missing} waiting · ${want.length - missing} found`;
  const list = $('#history');
  list.replaceChildren();
  if (!history.length) {
    list.append(h('li', { class: 'muted' }, 'Nothing hunted yet. Click the violet button next to any SoundCloud track.'));
    return;
  }
  for (const e of history) {
    const li = h('li', {},
      h('div', { class: 'top' },
        h('span', { class: `pill ${e.status}` }, e.status),
        h('a', { class: 'lbl', href: e.scUrl, target: '_blank', title: e.label }, e.label || e.scUrl),
        h('span', { class: 'muted' }, ago(e.updatedAt || e.at))),
      h('div', { class: 'sub muted', title: detailFor(e) }, detailFor(e)));
    if (e.status === 'review') {
      for (const c of e.candidates || []) {
        li.append(h('div', { class: 'cand' },
          h('span', { class: 't', title: `${c.artist ? `${c.artist} - ` : ''}${c.title}${c.version ? ` (${c.version})` : ''}` }, `${Math.round(c.score * 100)}% · ${c.sourceLabel} · ${c.artist ? `${c.artist} - ` : ''}${c.title}${c.version ? ` (${c.version})` : ''}`),
          h('button', {
            onclick: async (ev) => {
              ev.target.disabled = true;
              try {
                await send({ type: 'act', entryId: e.id, cid: c.cid });
              } catch (err) {
                $('#msg').textContent = err.message;
              }
              render();
            },
          }, ACTION_LABEL[c.kind] || 'Go')));
      }
    }
    list.append(li);
  }
}

$('#hunt-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = $('#url').value.trim();
  if (!url) return;
  $('#msg').textContent = 'Hunting… progress shows below.';
  try {
    await send({ type: 'hunt', url, origin: 'popup' });
  } catch (e) {
    $('#msg').textContent = e.message;
  }
  setTimeout(render, 400);
});

$('#recheck').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  $('#msg').textContent = 'Re-checking wantlist…';
  try {
    const r = await send({ type: 'recheck-want' });
    $('#msg').textContent = `Checked ${r.checked}, found ${r.found}.`;
  } catch (e) {
    $('#msg').textContent = e.message;
  }
  ev.target.disabled = false;
  render();
});

$('#clear').addEventListener('click', async (ev) => {
  ev.preventDefault();
  await send({ type: 'clear-history' });
  render();
});

$('#open-options').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.history || changes.wantlist)) render();
});

render();
