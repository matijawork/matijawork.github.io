// Moj raspored — frontend v2
// - SHA-256 password lock
// - GitHub sync s fresh SHA + 409 retry, queue samo na network error
// - Optimistic UI
// - Google Calendar timeline za Raspored

const APP_VERSION = '2.0.0';

const LS_KEYS = {
  token:  'mr.token',
  pwhash: 'mr.pwhash',
  queue:  'mr.queue',
  shas:   'mr.shas',
};

const FIXED_REPO   = 'matijawork/matijawork.github.io';
const FIXED_BRANCH = 'main';

const FILES = {
  plan:        'moj-raspored/PLAN.md',
  zadaci:      'moj-raspored/inbox.md',
  preferences: 'moj-raspored/preferences.md',
  context:     'moj-raspored/context.md',
};

const TIMELINE_START_H = 4;
const TIMELINE_END_H   = 23;
const PX_PER_MIN       = 1;

const state = {
  token:  localStorage.getItem(LS_KEYS.token) || '',
  queue:  JSON.parse(localStorage.getItem(LS_KEYS.queue) || '[]'),
  shas:   JSON.parse(localStorage.getItem(LS_KEYS.shas)  || '{}'),
  cache:  {},
  pollTimer: null,
  online: navigator.onLine,
  nowTimer: null,
};

const $ = id => document.getElementById(id);
const saveLS = (k, v) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));

function esc(s) { return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- Base64 UTF-8 safe ----------

function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

// ---------- Crypto ----------

async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function ensureDefaultPwHash() {
  if (!localStorage.getItem(LS_KEYS.pwhash)) {
    saveLS(LS_KEYS.pwhash, await sha256Hex('1'));
  }
}

async function verifyPassword(pw) {
  return (await sha256Hex(pw)) === localStorage.getItem(LS_KEYS.pwhash);
}

async function setPassword(newPw) {
  saveLS(LS_KEYS.pwhash, await sha256Hex(newPw));
}

// ---------- Status dot ----------

function setDot(kind) {
  const dot = $('status-dot');
  if (!dot) return;
  dot.classList.remove('online','offline','syncing');
  dot.classList.add(kind);
  dot.title = kind;
}
function refreshDot() { setDot(state.online ? 'online' : 'offline'); }

// ---------- GitHub REST ----------

class GhError extends Error {
  constructor(status, body) {
    super(`GitHub ${status}: ${String(body).slice(0,200)}`);
    this.status = status;
    this.body = body;
  }
}

async function gh(path, opts = {}) {
  if (!state.token) {
    const err = new Error('Token nije postavljen');
    err.code = 'NO_TOKEN';
    throw err;
  }
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${state.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GhError(res.status, body);
  }
  if (res.status === 204) return null;
  return res.json();
}

function isNetworkError(e) {
  return !(e instanceof GhError) && (e instanceof TypeError || e.name === 'TypeError');
}

async function fetchFile(name) {
  const path = FILES[name];
  const url = `/repos/${FIXED_REPO}/contents/${encodeURIComponent(path)}?ref=${FIXED_BRANCH}`;
  const data = await gh(url);
  const content = b64decode(data.content.replace(/\n/g, ''));
  state.shas[path] = data.sha;
  saveLS(LS_KEYS.shas, state.shas);
  return content;
}

async function fetchSha(path) {
  try {
    const data = await gh(`/repos/${FIXED_REPO}/contents/${encodeURIComponent(path)}?ref=${FIXED_BRANCH}`);
    return data.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function putFile(name, content, message, retries = 3) {
  const path = FILES[name];
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const sha = await fetchSha(path);
    const body = { message, content: b64encode(content), branch: FIXED_BRANCH };
    if (sha) body.sha = sha;
    try {
      const data = await gh(`/repos/${FIXED_REPO}/contents/${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      state.shas[path] = data.content.sha;
      saveLS(LS_KEYS.shas, state.shas);
      return data;
    } catch (e) {
      lastErr = e;
      if (e.status === 409 && i < retries - 1) {
        await new Promise(r => setTimeout(r, 150 * (i+1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ---------- Queue (ONLY network errors) ----------

function enqueue(op) {
  state.queue.push(op);
  saveLS(LS_KEYS.queue, state.queue);
}

async function flushQueue() {
  if (!state.online || !state.token || state.queue.length === 0) return;
  setDot('syncing');
  const remaining = [];
  for (const op of state.queue) {
    try {
      await putFile(op.file, op.content, op.message);
    } catch (e) {
      if (isNetworkError(e)) remaining.push(op);
      // API error → drop (stale), don't keep retrying forever
    }
  }
  state.queue = remaining;
  saveLS(LS_KEYS.queue, state.queue);
  refreshDot();
}

// ---------- Sync wrapper ----------

async function sync(name, content, message) {
  try {
    if (!state.online) {
      enqueue({ file: name, content, message });
      return { queued: true };
    }
    setDot('syncing');
    await putFile(name, content, message);
    refreshDot();
    return { ok: true };
  } catch (e) {
    refreshDot();
    if (isNetworkError(e)) {
      enqueue({ file: name, content, message });
      return { queued: true, error: 'offline' };
    }
    if (e.code === 'NO_TOKEN' || e.status === 401) {
      openSettings('Unesi/obnovi token — prethodni nije valjan.');
    }
    throw e;
  }
}

// ---------- Plan ----------

async function renderPlan() {
  const el = $('plan-content');
  el.textContent = 'Učitavanje…';
  try {
    const md = await fetchFile('plan');
    state.cache.plan = md;
    el.innerHTML = marked.parse(md);
    bindPlanCheckboxes();
    const hdr = md.match(/^# (.+)$/m);
    if (hdr) $('plan-title').textContent = hdr[1];
    $('plan-updated').textContent = 'ažurirano: ' + new Date().toLocaleTimeString('hr-HR',{hour:'2-digit',minute:'2-digit'});
  } catch (e) {
    el.innerHTML = `<p class="muted">Greška: ${esc(e.message)}</p>`;
    if (e.status === 401) openSettings('Token nije valjan.');
  }
}

function bindPlanCheckboxes() {
  $('plan-content').querySelectorAll('input[type=checkbox]').forEach((cb, idx) => {
    cb.disabled = false;
    cb.addEventListener('change', () => toggleChecklist(idx, cb.checked));
  });
}

async function toggleChecklist(idx, checked) {
  let md;
  try { md = await fetchFile('plan'); }
  catch (e) { alert('Ne mogu pročitati plan: ' + e.message); return; }
  let n = -1;
  const updated = md.replace(/- \[( |x|X)\]/g, (m) => {
    n++;
    return n === idx ? (checked ? '- [x]' : '- [ ]') : m;
  });
  state.cache.plan = updated;
  try {
    await sync('plan', updated, `plan: toggle #${idx}`);
    $('plan-content').innerHTML = marked.parse(updated);
    bindPlanCheckboxes();
  } catch (e) {
    alert('Sync fail: ' + e.message);
    renderPlan();
  }
}

// ---------- Zadaci ----------

function parseZadaci(md) {
  const lines = md.split('\n');
  const rx = /^-\s+\[\s?\]\s+(@\w+)\s+(.*)$/;
  return lines.reduce((acc, line, i) => {
    const m = line.match(rx);
    if (m) acc.push({ line: i, tag: m[1], text: m[2] });
    return acc;
  }, []);
}

function renderZadaciList(tasks, optimisticIdx) {
  const list = $('zadaci-list');
  list.innerHTML = '';
  if (!tasks.length) {
    list.innerHTML = '<li class="muted">Nema zadataka.</li>';
    return;
  }
  const rank = { '@hitno':0, '@danas':1, '@sutra':2, '@tjedan':3 };
  const sorted = [...tasks].sort((a,b) => (rank[a.tag] ?? 9) - (rank[b.tag] ?? 9));
  for (const t of sorted) {
    const li = document.createElement('li');
    li.className = 'task' + (t._optimistic ? ' optimistic' : '');
    const tagKey = t.tag.replace('@','');
    const safeTagKey = ['hitno','danas','sutra','tjedan'].includes(tagKey) ? tagKey : 'tjedan';
    li.innerHTML = `
      <span class="chip ${safeTagKey}">${esc(t.tag)}</span>
      <span class="text"></span>
      <button class="del" title="Obriši" aria-label="Obriši zadatak">✕</button>
    `;
    li.querySelector('.text').textContent = t.text;
    li.querySelector('.del').addEventListener('click', () => deleteTask(t));
    list.appendChild(li);
  }
}

async function renderZadaci() {
  const list = $('zadaci-list');
  list.innerHTML = '<li class="muted">Učitavanje…</li>';
  try {
    const md = await fetchFile('zadaci');
    state.cache.zadaci = md;
    renderZadaciList(parseZadaci(md));
  } catch (e) {
    list.innerHTML = `<li class="muted">Greška: ${esc(e.message)}</li>`;
    if (e.status === 401) openSettings('Token nije valjan.');
  }
}

async function addTask(text, tag) {
  // optimistic
  const current = parseZadaci(state.cache.zadaci || '');
  current.push({ line: -1, tag, text, _optimistic: true });
  renderZadaciList(current);

  let md;
  try { md = await fetchFile('zadaci'); }
  catch (e) { alert('Ne mogu pročitati zadatke: ' + e.message); return renderZadaci(); }

  let updated;
  const marker = /(## Aktivni zadaci\s*\n(?:<!--[^>]*-->\s*\n)?)/;
  if (marker.test(md)) {
    updated = md.replace(marker, (m) => `${m}- [ ] ${tag} ${text}\n`);
  } else {
    updated = md.trimEnd() + `\n- [ ] ${tag} ${text}\n`;
  }
  state.cache.zadaci = updated;

  try {
    const r = await sync('zadaci', updated, `zadaci: add ${tag} ${text.slice(0,40)}`);
    renderZadaciList(parseZadaci(updated));
    if (r && r.queued) showToast('Offline — spremljeno u queue');
  } catch (e) {
    alert('Dodavanje nije uspjelo: ' + e.message);
    renderZadaci();
  }
}

async function deleteTask(t) {
  let md;
  try { md = await fetchFile('zadaci'); }
  catch (e) { alert('Ne mogu pročitati zadatke: ' + e.message); return; }
  const lines = md.split('\n');
  const rx = new RegExp(`^-\\s+\\[\\s?\\]\\s+${t.tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s+${t.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`);
  let removed = false;
  const out = lines.filter(l => {
    if (!removed && rx.test(l)) { removed = true; return false; }
    return true;
  });
  if (!removed) { renderZadaci(); return; }
  const updated = out.join('\n');
  state.cache.zadaci = updated;

  // optimistic re-render
  renderZadaciList(parseZadaci(updated));

  try {
    await sync('zadaci', updated, `zadaci: del ${t.tag} ${t.text.slice(0,30)}`);
  } catch (e) {
    alert('Brisanje nije uspjelo: ' + e.message);
    renderZadaci();
  }
}

// ---------- Preferences ----------

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
    if (e.status === 401) openSettings('Token nije valjan.');
  }
}

async function savePreferences() {
  const md = $('preferences-editor').value;
  state.cache.preferences = md;
  $('preferences-status').textContent = 'spremam…';
  try {
    const r = await sync('preferences', md, 'preferences: update');
    $('preferences-status').textContent = r && r.queued ? 'offline — u queue' : 'spremljeno';
  } catch (e) {
    $('preferences-status').textContent = 'greška: ' + e.message;
  }
  setTimeout(() => $('preferences-status').textContent = '', 2500);
}

// ---------- Context ----------

async function renderContext() {
  const el = $('context-content');
  el.textContent = 'Učitavanje…';
  try {
    const md = await fetchFile('context');
    state.cache.context = md;
    el.innerHTML = marked.parse(md);
    $('context-size').textContent = `${new Blob([md]).size} B / 2048 B`;
  } catch (e) {
    el.innerHTML = `<p class="muted">Greška: ${esc(e.message)}</p>`;
    if (e.status === 401) openSettings('Token nije valjan.');
  }
}

// ---------- Raspored (timeline) ----------

function toMin(t) { const [h,m] = t.split(':').map(Number); return h*60 + m; }
function fromMin(m) { return `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }

function categorize(label) {
  const l = label.toLowerCase();
  if (/\b(škol|skol|sat\b|razred|učionic|ucionic)/.test(l)) return 'skola';
  if (/\btrening/.test(l)) return 'trening';
  if (/\bbiznis/.test(l)) return 'biznis';
  if (/\b(učenj|ucenj|mat|hrv|pov|engl)/.test(l)) return 'ucenje';
  if (/\b(kućans|kucans|spava|torba|check|pranje)/.test(l)) return 'kucanski';
  return 'other';
}

function parseRasporedTable(md) {
  const sect = md.match(/##\s*Raspored\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!sect) return [];
  const rows = [...sect[1].matchAll(/\|\s*(\d{1,2}:\d{2})\s*\|\s*([^\n|]+?)\s*\|/g)];
  const events = rows
    .map(r => ({ time: r[1], label: r[2].trim() }))
    .filter(e => /^\d{1,2}:\d{2}$/.test(e.time));
  return events.map((e, i) => {
    const startM = toMin(e.time);
    let endM;
    if (events[i+1]) endM = toMin(events[i+1].time);
    else endM = startM + 60;
    if (endM <= startM) endM = startM + 30;
    return {
      time: e.time,
      end: fromMin(endM),
      label: e.label,
      startM,
      endM,
      cat: categorize(e.label),
    };
  });
}

function renderRaspored() {
  const root = $('timeline');
  root.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'timeline-inner';

  // hour grid
  for (let h = TIMELINE_START_H; h <= TIMELINE_END_H; h++) {
    const row = document.createElement('div');
    row.className = 'timeline-hour';
    row.style.top = `${(h - TIMELINE_START_H) * 60}px`;
    row.innerHTML = `<span>${String(h).padStart(2,'0')}:00</span>`;
    inner.appendChild(row);
  }

  const md = state.cache.plan || '';
  const events = parseRasporedTable(md);

  let title = 'Danas';
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) title = h1[1];
  $('raspored-date').textContent = title;

  for (const ev of events) {
    const top = (ev.startM - TIMELINE_START_H * 60) * PX_PER_MIN;
    const height = Math.max(24, (ev.endM - ev.startM) * PX_PER_MIN - 4);
    if (top < 0 || top > (TIMELINE_END_H - TIMELINE_START_H + 1) * 60) continue;
    const block = document.createElement('div');
    block.className = `event ${ev.cat}`;
    block.style.top = `${top}px`;
    block.style.height = `${height}px`;
    block.innerHTML = `<span class="event-label"></span><span class="event-time">${ev.time}–${ev.end}</span>`;
    block.querySelector('.event-label').textContent = ev.label;
    block.addEventListener('click', () => showPopover(ev));
    inner.appendChild(block);
  }

  // now line
  const now = nowLineY();
  if (now !== null) {
    const line = document.createElement('div');
    line.className = 'timeline-now';
    line.style.top = `${now}px`;
    inner.appendChild(line);
  }

  root.appendChild(inner);

  // auto-scroll to now (or 08:00 if now outside)
  let scrollTo = now ?? ((8 - TIMELINE_START_H) * 60);
  scrollTo = Math.max(0, scrollTo - root.clientHeight / 3);
  root.scrollTop = scrollTo;

  startNowTimer();
}

function nowLineY() {
  const d = new Date();
  const m = d.getHours()*60 + d.getMinutes();
  if (m < TIMELINE_START_H*60 || m > TIMELINE_END_H*60 + 60) return null;
  return (m - TIMELINE_START_H * 60) * PX_PER_MIN;
}

function startNowTimer() {
  stopNowTimer();
  state.nowTimer = setInterval(() => {
    const line = document.querySelector('.timeline-now');
    const y = nowLineY();
    if (line && y !== null) line.style.top = `${y}px`;
  }, 60000);
}
function stopNowTimer() {
  if (state.nowTimer) { clearInterval(state.nowTimer); state.nowTimer = null; }
}

function showPopover(ev) {
  const p = $('raspored-popover');
  $('pop-title').textContent = ev.label;
  $('pop-time').textContent  = `${ev.time}–${ev.end}`;
  $('pop-cat').textContent   = `kategorija: ${ev.cat}`;
  p.hidden = false;
  clearTimeout(showPopover._t);
  showPopover._t = setTimeout(() => { p.hidden = true; }, 3500);
}

// ---------- Tabs ----------

async function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'plan') await renderPlan();
  if (name === 'raspored') {
    if (!state.cache.plan) await renderPlan();
    renderRaspored();
  }
  if (name === 'zadaci') await renderZadaci();
  if (name === 'preferences') await renderPreferences();
  if (name === 'context') await renderContext();
}

// ---------- Polling ----------

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const active = document.querySelector('.tab.active')?.dataset.tab;
    if (active === 'plan') renderPlan();
    if (active === 'zadaci') renderZadaci();
    if (active === 'raspored') { renderPlan().then(() => renderRaspored()); }
  }, 60000);
}
function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

// ---------- Settings ----------

function openSettings(msg) {
  $('token-input').value = state.token;
  $('pw-old').value = '';
  $('pw-new').value = '';
  $('pw-confirm').value = '';
  $('pw-status').textContent = '';
  $('token-status').textContent = msg || '';
  $('app-version').textContent = APP_VERSION;
  $('settings-dialog').showModal();
}

async function handlePwChange() {
  const oldPw = $('pw-old').value;
  const newPw = $('pw-new').value;
  const conf  = $('pw-confirm').value;
  const s = $('pw-status');
  s.style.color = '';
  if (!newPw) { s.style.color = 'var(--danger)'; s.textContent = 'nova šifra prazna'; return; }
  if (newPw !== conf) { s.style.color = 'var(--danger)'; s.textContent = 'potvrda ne odgovara'; return; }
  if (!await verifyPassword(oldPw)) { s.style.color = 'var(--danger)'; s.textContent = 'stara šifra pogrešna'; return; }
  await setPassword(newPw);
  s.style.color = 'var(--success)';
  s.textContent = 'šifra promijenjena';
  $('pw-old').value = ''; $('pw-new').value = ''; $('pw-confirm').value = '';
  setTimeout(() => s.textContent = '', 2500);
}

function handleTokenSave() {
  const t = $('token-input').value.trim();
  state.token = t;
  saveLS(LS_KEYS.token, t);
  state.shas = {};
  saveLS(LS_KEYS.shas, state.shas);
  $('token-status').textContent = 'spremljeno';
  setTimeout(() => $('token-status').textContent = '', 2000);
  const active = document.querySelector('.tab.active')?.dataset.tab || 'plan';
  switchTab(active);
}

function handleClearCache() {
  const keep = localStorage.getItem(LS_KEYS.token);
  const pw   = localStorage.getItem(LS_KEYS.pwhash);
  localStorage.clear();
  sessionStorage.clear();
  if (keep) saveLS(LS_KEYS.token, keep);
  if (pw)   saveLS(LS_KEYS.pwhash, pw);
  state.queue = []; state.shas = {}; state.cache = {};
  saveLS(LS_KEYS.queue, state.queue);
  saveLS(LS_KEYS.shas, state.shas);
  showToast('Cache obrisan');
}

function handleClearAll() {
  if (!confirm('Obrisati token, šifru i cache? (šifra se resetira na "1")')) return;
  localStorage.clear();
  sessionStorage.clear();
  state.token = ''; state.queue = []; state.shas = {}; state.cache = {};
  location.reload();
}

// ---------- Toast ----------

function showToast(msg) {
  let t = document.getElementById('mr-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'mr-toast';
    t.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--elevated);border:1px solid var(--border);padding:10px 14px;border-radius:10px;font-size:13px;z-index:30;box-shadow:var(--shadow)';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

// ---------- Lock screen ----------

async function unlockApp() {
  $('lock-screen').hidden = true;
  $('app').hidden = false;
  sessionStorage.setItem('mr.auth', '1');
  refreshDot();
  if (!state.token) {
    openSettings('Unesi GitHub token (prvi put).');
  } else {
    renderPlan();
    flushQueue();
  }
  startPolling();
}

async function handleLockSubmit(e) {
  e.preventDefault();
  const pw = $('lock-input').value;
  const errEl = $('lock-error');
  errEl.hidden = true;
  if (await verifyPassword(pw)) {
    await unlockApp();
  } else {
    errEl.textContent = 'Pogrešna šifra';
    errEl.hidden = false;
    $('lock-input').value = '';
    $('lock-input').focus();
  }
}

async function initAuth() {
  await ensureDefaultPwHash();
  if (sessionStorage.getItem('mr.auth') === '1') {
    await unlockApp();
  } else {
    $('lock-screen').hidden = false;
    $('app').hidden = true;
    $('lock-input').focus();
  }
}

// ---------- Service worker ----------

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---------- Init ----------

function bindEvents() {
  $('lock-form').addEventListener('submit', handleLockSubmit);
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('settings-btn').addEventListener('click', () => openSettings());
  $('refresh-btn').addEventListener('click', () => {
    const active = document.querySelector('.tab.active')?.dataset.tab || 'plan';
    switchTab(active);
  });
  $('preferences-save').addEventListener('click', savePreferences);
  $('zadaci-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('zadaci-input').value.trim();
    if (!text) return;
    const tag = $('zadaci-tag').value;
    $('zadaci-input').value = '';
    await addTask(text, tag);
  });
  $('pw-save').addEventListener('click', handlePwChange);
  $('token-save').addEventListener('click', handleTokenSave);
  $('clear-cache').addEventListener('click', handleClearCache);
  $('clear-all').addEventListener('click', handleClearAll);

  window.addEventListener('online',  () => { state.online = true;  refreshDot(); flushQueue(); });
  window.addEventListener('offline', () => { state.online = false; refreshDot(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushQueue();
  });
}

bindEvents();
initAuth();
registerSW();
