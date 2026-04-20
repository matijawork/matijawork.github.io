// Moj raspored — frontend (GitHub REST API, vanilla JS)

const LS_KEYS = {
  token:  'mr.token',
  repo:   'mr.repo',
  branch: 'mr.branch',
  queue:  'mr.queue',
  shas:   'mr.shas',
};

const FILES = {
  plan:        'moj-raspored/PLAN.md',
  inbox:       'moj-raspored/inbox.md',
  preferences: 'moj-raspored/preferences.md',
  context:     'moj-raspored/context.md',
};

const POLL_INTERVAL = 60_000;

const state = {
  token:  localStorage.getItem(LS_KEYS.token)  || '',
  repo:   localStorage.getItem(LS_KEYS.repo)   || 'matijawork/matijawork.github.io',
  branch: localStorage.getItem(LS_KEYS.branch) || 'main',
  shas:   JSON.parse(localStorage.getItem(LS_KEYS.shas) || '{}'),
  queue:  JSON.parse(localStorage.getItem(LS_KEYS.queue) || '[]'),
  cache:  {},
  pollTimer: null,
  online: navigator.onLine,
};

// ---------- Utils ----------

const $ = id => document.getElementById(id);
const saveLS = (k, v) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));

function updateStatusDot() {
  const dot = $('status-dot');
  dot.classList.remove('online','offline','syncing');
  dot.classList.add(state.online ? 'online' : 'offline');
  dot.title = state.online ? 'online' : 'offline';
}

function setStatus(kind) {
  const dot = $('status-dot');
  dot.classList.remove('online','offline','syncing');
  dot.classList.add(kind);
}

// ---------- GitHub REST ----------

async function gh(path, opts = {}) {
  if (!state.token) throw new Error('Token nije postavljen (⚙).');
  const url = `https://api.github.com${path}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${state.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchFile(name) {
  const path = FILES[name];
  const url = `/repos/${state.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(state.branch)}`;
  const data = await gh(url);
  const content = b64decode(data.content.replace(/\n/g, ''));
  state.shas[path] = data.sha;
  saveLS(LS_KEYS.shas, state.shas);
  return content;
}

async function putFile(name, content, message) {
  const path = FILES[name];
  const body = {
    message,
    content: b64encode(content),
    branch: state.branch,
  };
  if (state.shas[path]) body.sha = state.shas[path];
  const url = `/repos/${state.repo}/contents/${encodeURIComponent(path)}`;
  const data = await gh(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  state.shas[path] = data.content.sha;
  saveLS(LS_KEYS.shas, state.shas);
  return data;
}

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// ---------- Offline queue ----------

function enqueue(op) {
  state.queue.push(op);
  saveLS(LS_KEYS.queue, state.queue);
}

async function flushQueue() {
  if (!state.online || !state.token || state.queue.length === 0) return;
  setStatus('syncing');
  const remaining = [];
  for (const op of state.queue) {
    try {
      await putFile(op.file, op.content, op.message);
    } catch (e) {
      console.error('flush fail', e);
      remaining.push(op);
    }
  }
  state.queue = remaining;
  saveLS(LS_KEYS.queue, state.queue);
  updateStatusDot();
}

// ---------- Render: Plan ----------

async function renderPlan() {
  $('plan-content').textContent = 'Učitavanje…';
  try {
    const md = await fetchFile('plan');
    state.cache.plan = md;
    $('plan-content').innerHTML = marked.parse(md);
    bindPlanCheckboxes();
    const hdr = md.match(/^# (.+)$/m);
    if (hdr) $('plan-title').textContent = hdr[1];
    $('plan-updated').textContent = 'ažurirano: ' + new Date().toLocaleTimeString('hr-HR', {hour:'2-digit',minute:'2-digit'});
  } catch (e) {
    $('plan-content').innerHTML = `<p class="muted">Greška: ${escape(e.message)}</p>`;
  }
}

function bindPlanCheckboxes() {
  const root = $('plan-content');
  root.querySelectorAll('input[type=checkbox]').forEach((cb, idx) => {
    cb.disabled = false;
    cb.addEventListener('change', () => toggleChecklist(idx, cb.checked));
  });
}

async function toggleChecklist(idx, checked) {
  const md = state.cache.plan || '';
  let n = -1;
  const updated = md.replace(/- \[( |x|X)\]/g, (m) => {
    n++;
    if (n === idx) return checked ? '- [x]' : '- [ ]';
    return m;
  });
  state.cache.plan = updated;
  const op = {
    file: 'plan',
    content: updated,
    message: `plan: toggle checklist #${idx}`,
  };
  try {
    if (state.online) {
      setStatus('syncing');
      await putFile('plan', updated, op.message);
      updateStatusDot();
    } else {
      enqueue(op);
    }
  } catch (e) {
    enqueue(op);
    alert('Sync fail, spremljeno u queue: ' + e.message);
  }
}

// ---------- Render: Inbox ----------

async function renderInbox() {
  const list = $('inbox-list');
  list.innerHTML = '<li class="muted">Učitavanje…</li>';
  try {
    const md = await fetchFile('inbox');
    state.cache.inbox = md;
    list.innerHTML = '';
    const tasks = parseInboxTasks(md);
    if (!tasks.length) {
      list.innerHTML = '<li class="muted">Prazan inbox.</li>';
      return;
    }
    const rank = { '@hitno':0, '@danas':1, '@sutra':2, '@tjedan':3, '@kasnije':4 };
    tasks.sort((a,b) => (rank[a.tag]??9) - (rank[b.tag]??9));
    for (const t of tasks) list.appendChild(renderTask(t));
  } catch (e) {
    list.innerHTML = `<li class="muted">Greška: ${escape(e.message)}</li>`;
  }
}

function parseInboxTasks(md) {
  const lines = md.split('\n');
  const rx = /^-\s+\[\s?\]\s+(@\w+)\s+(.*)$/;
  return lines.reduce((acc, line, i) => {
    const m = line.match(rx);
    if (m) acc.push({ line: i, tag: m[1], text: m[2] });
    return acc;
  }, []);
}

function renderTask(t) {
  const li = document.createElement('li');
  li.className = 'task';
  const tagKey = t.tag.replace('@','');
  li.innerHTML = `
    <span class="chip ${tagKey}">${t.tag}</span>
    <span class="text"></span>
    <button class="del" title="Obriši">✕</button>
  `;
  li.querySelector('.text').textContent = t.text;
  li.querySelector('.del').addEventListener('click', () => deleteTask(t));
  return li;
}

async function addTask(text, tag) {
  const md = state.cache.inbox || await fetchFile('inbox');
  const updated = md.replace(/(## Aktivni zadaci\s*\n(?:<!--[^>]*-->\s*\n)?)/,
    (m) => `${m}- [ ] ${tag} ${text}\n`);
  const final = updated === md
    ? md.trimEnd() + `\n- [ ] ${tag} ${text}\n`
    : updated;
  state.cache.inbox = final;
  await commitInbox(final, `inbox: add ${tag} ${text.slice(0,40)}`);
  renderInbox();
}

async function deleteTask(t) {
  const md = state.cache.inbox || '';
  const lines = md.split('\n');
  lines.splice(t.line, 1);
  const final = lines.join('\n');
  state.cache.inbox = final;
  await commitInbox(final, `inbox: del ${t.tag} ${t.text.slice(0,30)}`);
  renderInbox();
}

async function commitInbox(md, msg) {
  const op = { file: 'inbox', content: md, message: msg };
  try {
    if (state.online) {
      setStatus('syncing');
      await putFile('inbox', md, msg);
      updateStatusDot();
    } else {
      enqueue(op);
    }
  } catch (e) {
    enqueue(op);
    alert('Sync fail, spremljeno u queue: ' + e.message);
  }
}

// ---------- Render: Preferences ----------

async function renderPreferences() {
  const ta = $('preferences-editor');
  ta.value = 'Učitavanje…';
  try {
    const md = await fetchFile('preferences');
    state.cache.preferences = md;
    ta.value = md;
    $('preferences-status').textContent = '';
  } catch (e) {
    ta.value = '';
    $('preferences-status').textContent = 'Greška: ' + e.message;
  }
}

async function savePreferences() {
  const md = $('preferences-editor').value;
  state.cache.preferences = md;
  $('preferences-status').textContent = 'spremam…';
  try {
    if (state.online) {
      await putFile('preferences', md, 'preferences: update');
      $('preferences-status').textContent = 'spremljeno';
    } else {
      enqueue({ file: 'preferences', content: md, message: 'preferences: update' });
      $('preferences-status').textContent = 'offline — u queue';
    }
  } catch (e) {
    $('preferences-status').textContent = 'greška: ' + e.message;
  }
  setTimeout(() => $('preferences-status').textContent = '', 2500);
}

// ---------- Render: Context ----------

async function renderContext() {
  const el = $('context-content');
  el.textContent = 'Učitavanje…';
  try {
    const md = await fetchFile('context');
    state.cache.context = md;
    el.innerHTML = marked.parse(md);
    const size = new Blob([md]).size;
    $('context-size').textContent = `${size} B / 2048 B`;
  } catch (e) {
    el.innerHTML = `<p class="muted">Greška: ${escape(e.message)}</p>`;
  }
}

// ---------- Tabs ----------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  const map = { plan: renderPlan, inbox: renderInbox, preferences: renderPreferences, context: renderContext };
  map[name] && map[name]();
}

// ---------- Polling ----------

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const active = document.querySelector('.tab.active')?.dataset.tab;
    if (active === 'plan') renderPlan();
    if (active === 'inbox') renderInbox();
  }, POLL_INTERVAL);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

// ---------- Settings ----------

function openSettings() {
  $('token-input').value = state.token;
  $('repo-input').value = state.repo;
  $('branch-input').value = state.branch;
  $('settings-dialog').showModal();
}

$('settings-dialog').addEventListener('close', () => {
  if ($('settings-dialog').returnValue === 'save') {
    state.token = $('token-input').value.trim();
    state.repo = $('repo-input').value.trim() || 'matijawork/matijawork.github.io';
    state.branch = $('branch-input').value.trim() || 'main';
    saveLS(LS_KEYS.token, state.token);
    saveLS(LS_KEYS.repo, state.repo);
    saveLS(LS_KEYS.branch, state.branch);
    state.shas = {};
    saveLS(LS_KEYS.shas, state.shas);
    const active = document.querySelector('.tab.active')?.dataset.tab || 'plan';
    switchTab(active);
  }
});

// ---------- Helpers ----------

function escape(s) { return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- Init ----------

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('settings-btn').addEventListener('click', openSettings);
$('refresh-btn').addEventListener('click', () => {
  const active = document.querySelector('.tab.active')?.dataset.tab || 'plan';
  switchTab(active);
});
$('preferences-save').addEventListener('click', savePreferences);
$('inbox-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('inbox-input').value.trim();
  if (!text) return;
  const tag = $('inbox-tag').value;
  $('inbox-input').value = '';
  await addTask(text, tag);
});

window.addEventListener('online', () => { state.online = true; updateStatusDot(); flushQueue(); });
window.addEventListener('offline', () => { state.online = false; updateStatusDot(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') flushQueue();
});

updateStatusDot();
if (!state.token) {
  openSettings();
} else {
  renderPlan();
  flushQueue();
}
startPolling();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
