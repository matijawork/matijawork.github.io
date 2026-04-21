// Moj raspored — frontend v2.3.0
// - No password lock (removed)
// - Per-path write mutex → zero races → no 409 under normal use
// - Fresh SHA fetch + 409 retry for each PUT
// - Unified sync() → single write path for every file
// - Toast stack (error/success/info), top progress bar, empty states
// - Single-scroll layout: Raspored → Danas → Zadaci; Preferences/Context/Settings as modals

const APP_VERSION = '2.3.0';
const DEBUG = true;
const dlog = (...a) => { if (DEBUG) console.log('[mr]', ...a); };
const derr = (...a) => console.error('[mr]', ...a);

const LS = {
  token: 'mr.token',
  queue: 'mr.queue',
};

// Legacy keys to purge on boot (v2.0 — v2.2 left these around):
const LEGACY_KEYS = ['mr.pwhash', 'mr.salt', 'mr.unlockFails', 'mr.lockoutUntil', 'mr.shas'];

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
  token:  localStorage.getItem(LS.token) || '',
  queue:  JSON.parse(localStorage.getItem(LS.queue) || '[]'),
  cache:  {},
  pollTimer: null,
  online: navigator.onLine,
  nowTimer: null,
  syncCount: 0,
};

const $ = id => document.getElementById(id);
const save = (k, v) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
const esc = s => (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---------- Base64 UTF-8 safe ----------
const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = b => decodeURIComponent(escape(atob(b)));

// ---------- Legacy cleanup ----------

function purgeLegacyKeys() {
  let removed = 0;
  for (const k of LEGACY_KEYS) {
    if (localStorage.getItem(k) !== null) {
      localStorage.removeItem(k);
      removed++;
    }
  }
  if (removed) dlog(`purged ${removed} legacy keys`);
}

// ---------- Toast stack ----------

function toast(msg, type = 'info', ms = 4000) {
  const stack = $('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  el.addEventListener('click', () => dismiss());
  let startX = null;
  el.addEventListener('touchstart', e => { startX = e.touches[0].clientX; });
  el.addEventListener('touchmove',  e => {
    if (startX === null) return;
    const dx = e.touches[0].clientX - startX;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 200));
  });
  el.addEventListener('touchend', e => {
    if (startX === null) return;
    const dx = (e.changedTouches[0].clientX) - startX;
    if (Math.abs(dx) > 80) dismiss();
    else { el.style.transform = ''; el.style.opacity = ''; }
    startX = null;
  });
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const t = setTimeout(dismiss, ms);
  function dismiss() {
    clearTimeout(t);
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }
}
const toastOk  = m => toast(m, 'success', 2500);
const toastErr = m => toast(m, 'error',  5000);

// ---------- Progress bar ----------

function startSync() {
  state.syncCount++;
  $('progress-bar')?.classList.add('active');
  setDot('syncing');
}
function endSync() {
  state.syncCount = Math.max(0, state.syncCount - 1);
  if (state.syncCount === 0) {
    $('progress-bar')?.classList.remove('active');
    refreshDot();
  }
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
  constructor(status, body) { super(`GitHub ${status}: ${String(body).slice(0,200)}`); this.status = status; this.body = body; }
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

const isNetworkError = e => !(e instanceof GhError) && (e instanceof TypeError || e?.name === 'TypeError');

// ---------- Unified file I/O ----------

async function fetchFile(name) {
  const path = FILES[name];
  const data = await gh(`/repos/${FIXED_REPO}/contents/${encodeURIComponent(path)}?ref=${FIXED_BRANCH}`);
  return { content: b64dec(data.content.replace(/\n/g, '')), sha: data.sha };
}

async function fetchSha(path) {
  try {
    const d = await gh(`/repos/${FIXED_REPO}/contents/${encodeURIComponent(path)}?ref=${FIXED_BRANCH}`);
    return d.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function putFile(name, content, message, retries = 4) {
  const path = FILES[name];
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const sha = await fetchSha(path);
    const body = { message, content: b64enc(content), branch: FIXED_BRANCH };
    if (sha) body.sha = sha;
    try {
      dlog(`PUT ${path} attempt ${i+1}/${retries} sha=${sha?.slice(0,7) || 'null'}`);
      return await gh(`/repos/${FIXED_REPO}/contents/${encodeURIComponent(path)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e;
      if ((e.status === 409 || e.status === 422) && i < retries - 1) {
        const wait = 120 * (i + 1);
        dlog(`PUT ${path} ${e.status} → retry after ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const mutex = Object.create(null);
function runExclusive(key, fn) {
  const prev = mutex[key] || Promise.resolve();
  const task = prev.catch(() => {}).then(fn);
  mutex[key] = task;
  return task;
}

function enqueue(op) {
  state.queue.push(op);
  save(LS.queue, state.queue);
}

async function flushQueue() {
  if (!state.online || !state.token || state.queue.length === 0) return;
  startSync();
  const keep = [];
  for (const op of state.queue) {
    try { await runExclusive(op.file, () => putFile(op.file, op.content, op.message)); }
    catch (e) {
      if (isNetworkError(e)) keep.push(op);
      else derr('flushQueue drop (API err):', e.message);
    }
  }
  state.queue = keep;
  save(LS.queue, state.queue);
  endSync();
}

async function sync(name, content, message) {
  if (!state.online) {
    enqueue({ file: name, content, message });
    toast('Offline — spremljeno u queue', 'info');
    return { queued: true };
  }
  startSync();
  try {
    await runExclusive(name, () => putFile(name, content, message));
    return { ok: true };
  } catch (e) {
    if (isNetworkError(e)) {
      enqueue({ file: name, content, message });
      toast('Offline — spremljeno u queue', 'info');
      return { queued: true };
    }
    if (e.code === 'NO_TOKEN' || e.status === 401) {
      toastErr('Token nedostaje ili je istekao. Otvori Postavke → GitHub token.');
      openDialog('settings-dialog', 'Unesi/obnovi token.');
    } else {
      toastErr('Sync fail: ' + (e.message || e));
    }
    throw e;
  } finally {
    endSync();
  }
}

// ---------- Plan + Danas checklist ----------

async function loadPlan() {
  try {
    startSync();
    const { content } = await fetchFile('plan');
    state.cache.plan = content;
    renderHero(content);
    renderRaspored();
    renderDanas(content);
  } catch (e) {
    if (e.status === 404) {
      state.cache.plan = '';
      renderHero('');
      renderRaspored();
      renderDanas('');
      toast('PLAN.md ne postoji (generirat će ga dnevna rutina).', 'info');
    } else {
      toastErr('Plan: ' + e.message);
      if (e.status === 401 || e.code === 'NO_TOKEN') openDialog('settings-dialog', 'Unesi token.');
    }
  } finally {
    endSync();
  }
}

function renderHero(md) {
  const h1 = md.match(/^#\s+(.+)$/m);
  const smjena = md.match(/Smjena:\s*([^\n(]+)\s*\(([^)]+)\)/i);
  $('hero-title').textContent = h1 ? h1[1] : 'Plan';
  if (smjena) {
    $('hero-meta').textContent = `Smjena: ${smjena[1].trim()} (${smjena[2].trim()})`;
  } else {
    const d = new Date();
    $('hero-meta').textContent = d.toLocaleDateString('hr-HR', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  }
}

function renderDanas(md) {
  const el = $('danas-checklist');
  const sect = md.match(/##\s*Checklist\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!sect) {
    el.innerHTML = '<p class="muted empty">Nema danas-checkliste u planu.</p>';
    return;
  }
  const lines = sect[1].split('\n').filter(l => /^-\s+\[/.test(l));
  if (!lines.length) {
    el.innerHTML = '<p class="muted empty">Nema stavki.</p>';
    return;
  }
  const html = marked.parse(lines.join('\n'));
  el.innerHTML = html;
  bindDanasCheckboxes();
}

function bindDanasCheckboxes() {
  $('danas-checklist').querySelectorAll('input[type=checkbox]').forEach((cb, idx) => {
    cb.disabled = false;
    cb.addEventListener('change', () => toggleDanas(idx, cb.checked));
  });
}

async function toggleDanas(sectionIdx, checked) {
  let md;
  try { md = (await fetchFile('plan')).content; }
  catch (e) { toastErr('Ne mogu pročitati plan: ' + e.message); return; }

  const re = /(##\s*Checklist\s*\n)([\s\S]*?)(?=\n##\s|$)/i;
  const m = md.match(re);
  if (!m) { toastErr('Checklist sekcija nije pronađena.'); return; }
  let n = -1;
  const rewritten = m[2].replace(/- \[( |x|X)\]/g, s => {
    n++;
    return n === sectionIdx ? (checked ? '- [x]' : '- [ ]') : s;
  });
  const updated = md.replace(re, m[1] + rewritten);
  state.cache.plan = updated;
  renderDanas(updated);

  try { await sync('plan', updated, `plan: toggle #${sectionIdx}`); toastOk('Spremljeno'); }
  catch (e) { await loadPlan(); }
}

// ---------- Raspored (timeline) ----------

const toMin   = t => { const [h,m] = t.split(':').map(Number); return h*60 + m; };
const fromMin = m => `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

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
  const items = rows.map(r => ({ time: r[1], label: r[2].trim() })).filter(e => /^\d{1,2}:\d{2}$/.test(e.time));
  return items.map((e, i) => {
    const startM = toMin(e.time);
    let endM = items[i+1] ? toMin(items[i+1].time) : startM + 60;
    if (endM <= startM) endM = startM + 30;
    return { time: e.time, end: fromMin(endM), label: e.label, startM, endM, cat: categorize(e.label) };
  });
}

function renderRaspored() {
  const root = $('timeline');
  if (!root) return;
  root.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'timeline-inner';

  for (let h = TIMELINE_START_H; h <= TIMELINE_END_H; h++) {
    const row = document.createElement('div');
    row.className = 'timeline-hour';
    row.style.top = `${(h - TIMELINE_START_H) * 60}px`;
    row.innerHTML = `<span>${String(h).padStart(2,'0')}:00</span>`;
    inner.appendChild(row);
  }

  const md = state.cache.plan || '';
  const events = parseRasporedTable(md);

  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'empty timeline-empty';
    empty.textContent = md ? 'Nema stavki u sekciji ## Raspored.' : 'Plan još nije generiran.';
    inner.appendChild(empty);
  }

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

  const nowY = nowLineY();
  if (nowY !== null) {
    const line = document.createElement('div');
    line.className = 'timeline-now';
    line.style.top = `${nowY}px`;
    inner.appendChild(line);
  }

  root.appendChild(inner);

  let scrollTo = nowY ?? ((8 - TIMELINE_START_H) * 60);
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
  }, 60_000);
}
function stopNowTimer() { if (state.nowTimer) { clearInterval(state.nowTimer); state.nowTimer = null; } }

function showPopover(ev) {
  const p = $('raspored-popover');
  $('pop-title').textContent = ev.label;
  $('pop-time').textContent  = `${ev.time}–${ev.end}`;
  $('pop-cat').textContent   = `kategorija: ${ev.cat}`;
  p.hidden = false;
  clearTimeout(showPopover._t);
  showPopover._t = setTimeout(() => { p.hidden = true; }, 3500);
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

function renderZadaciList(tasks) {
  const list = $('zadaci-list');
  list.innerHTML = '';
  if (!tasks.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Još nema zadataka. Dodaj prvi.';
    list.appendChild(li);
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
      <span class="chip ${safeTagKey}"></span>
      <span class="text"></span>
      <button class="del" title="Obriši" aria-label="Obriši zadatak">✕</button>
    `;
    li.querySelector('.chip').textContent = t.tag;
    li.querySelector('.text').textContent = t.text;
    li.querySelector('.del').addEventListener('click', () => deleteTask(t, li));
    list.appendChild(li);
  }
}

async function loadZadaci() {
  const list = $('zadaci-list');
  list.innerHTML = '<li class="empty">Učitavanje…</li>';
  try {
    startSync();
    const { content } = await fetchFile('zadaci');
    state.cache.zadaci = content;
    renderZadaciList(parseZadaci(content));
  } catch (e) {
    if (e.status === 404) {
      state.cache.zadaci = '## Aktivni zadaci\n';
      renderZadaciList([]);
    } else {
      list.innerHTML = `<li class="empty">Greška: ${esc(e.message)}</li>`;
      toastErr('Zadaci: ' + e.message);
      if (e.status === 401 || e.code === 'NO_TOKEN') openDialog('settings-dialog', 'Unesi token.');
    }
  } finally { endSync(); }
}

async function addTask(text, tag) {
  dlog('addTask', tag, text);
  const base = parseZadaci(state.cache.zadaci || '');
  base.push({ line: -1, tag, text, _optimistic: true });
  renderZadaciList(base);

  try {
    let md;
    try { md = (await fetchFile('zadaci')).content; }
    catch (e) { if (e.status === 404) md = '## Aktivni zadaci\n'; else throw e; }
    let updated;
    const marker = /(## Aktivni zadaci\s*\n(?:<!--[^>]*-->\s*\n)?)/;
    if (marker.test(md)) updated = md.replace(marker, m => `${m}- [ ] ${tag} ${text}\n`);
    else                 updated = md.trimEnd() + `\n## Aktivni zadaci\n- [ ] ${tag} ${text}\n`;

    state.cache.zadaci = updated;
    await sync('zadaci', updated, `zadaci: add ${tag} ${text.slice(0,40)}`);
    renderZadaciList(parseZadaci(updated));
    toastOk('Dodano');
  } catch (e) {
    derr('addTask fail', e);
    toastErr('Dodavanje nije uspjelo: ' + (e.message || e));
    await loadZadaci();
  }
}

async function deleteTask(t, liEl) {
  dlog('deleteTask', t.tag, t.text);
  if (liEl) liEl.classList.add('removing');
  try {
    let md;
    try { md = (await fetchFile('zadaci')).content; }
    catch (e) { if (e.status === 404) md = ''; else throw e; }
    const re = new RegExp(
      `^-\\s+\\[\\s?\\]\\s+${t.tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s+${t.text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`
    );
    const lines = md.split('\n');
    let removed = false;
    const out = lines.filter(l => {
      if (!removed && re.test(l)) { removed = true; return false; }
      return true;
    });
    if (!removed) { toast('Zadatak nije pronađen (možda već obrisan).', 'info'); return loadZadaci(); }
    const updated = out.join('\n');
    state.cache.zadaci = updated;
    await sync('zadaci', updated, `zadaci: del ${t.tag} ${t.text.slice(0,30)}`);
    renderZadaciList(parseZadaci(updated));
    toastOk('Obrisano');
  } catch (e) {
    derr('deleteTask fail', e);
    toastErr('Brisanje nije uspjelo: ' + (e.message || e));
    await loadZadaci();
  }
}

// ---------- Preferences & Context (modals) ----------

async function openPreferences() {
  openDialog('preferences-dialog');
  const ta = $('preferences-editor');
  ta.value = 'Učitavanje…';
  try {
    const { content } = await fetchFile('preferences');
    state.cache.preferences = content;
    ta.value = content;
  } catch (e) {
    ta.value = '';
    toastErr('Preferencije: ' + e.message);
    if (e.status === 401 || e.code === 'NO_TOKEN') openDialog('settings-dialog', 'Unesi token.');
  }
}

async function savePreferences() {
  const md = $('preferences-editor').value;
  state.cache.preferences = md;
  try {
    await sync('preferences', md, 'preferences: update');
    toastOk('Preferencije spremljene');
    $('preferences-dialog').close();
  } catch (e) { /* sync already toasted */ }
}

async function openContext() {
  openDialog('context-dialog');
  const el = $('context-content');
  el.textContent = 'Učitavanje…';
  try {
    const { content } = await fetchFile('context');
    state.cache.context = content;
    el.innerHTML = marked.parse(content);
    $('context-size').textContent = `${new Blob([content]).size} B / 2048 B`;
  } catch (e) {
    el.innerHTML = `<p class="muted">Greška: ${esc(e.message)}</p>`;
    if (e.status === 401 || e.code === 'NO_TOKEN') openDialog('settings-dialog', 'Unesi token.');
  }
}

// ---------- Dialogs ----------

function openDialog(id, msg) {
  const d = $(id);
  if (!d) return;
  if (id === 'settings-dialog') {
    $('token-input').value = state.token;
    $('token-status').textContent = msg || '';
    $('app-version').textContent = APP_VERSION;
  }
  if (!d.open) d.showModal();
}

// ---------- Token + maintenance ----------

function handleTokenSave() {
  const t = $('token-input').value.trim();
  state.token = t;
  save(LS.token, t);
  $('token-status').textContent = 'spremljeno';
  setTimeout(() => $('token-status').textContent = '', 2000);
  toastOk('Token spremljen');
  loadPlan(); loadZadaci();
}

function handleClearCache() {
  const tok = localStorage.getItem(LS.token);
  localStorage.clear();
  sessionStorage.clear();
  if (tok) save(LS.token, tok);
  state.queue = []; state.cache = {};
  toastOk('Cache obrisan');
}

function handleClearAll() {
  if (!confirm('Obrisati token i cache?')) return;
  localStorage.clear();
  sessionStorage.clear();
  state.token = ''; state.queue = []; state.cache = {};
  location.reload();
}

// ---------- Polling ----------

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    loadPlan(); loadZadaci();
  }, 60_000);
}
function stopPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

// ---------- SW ----------

function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- Init ----------

function bindEvents() {
  $('settings-btn').addEventListener('click', () => openDialog('settings-dialog'));
  $('refresh-btn').addEventListener('click', () => { loadPlan(); loadZadaci(); });

  $('footer-preferences').addEventListener('click', openPreferences);
  $('footer-context').addEventListener('click', openContext);
  $('footer-settings').addEventListener('click', () => openDialog('settings-dialog'));

  $('preferences-save').addEventListener('click', savePreferences);

  $('zadaci-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('zadaci-input');
    const text = input.value.trim();
    if (!text) { toast('Napiši nešto prije dodavanja.', 'info'); return; }
    const tag = $('zadaci-tag').value || '@sutra';
    input.value = '';
    await addTask(text, tag);
  });

  $('token-save').addEventListener('click', handleTokenSave);
  $('clear-cache').addEventListener('click', handleClearCache);
  $('clear-all').addEventListener('click', handleClearAll);

  window.addEventListener('online',  () => { state.online = true;  refreshDot(); flushQueue(); });
  window.addEventListener('offline', () => { state.online = false; refreshDot(); toast('Offline', 'info'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushQueue();
  });
}

async function initApp() {
  refreshDot();
  if (!state.token) {
    openDialog('settings-dialog', 'Unesi GitHub token (prvi put).');
    return;
  }
  await Promise.all([loadPlan(), loadZadaci()]);
  flushQueue();
  startPolling();
}

function boot() {
  purgeLegacyKeys();
  try { bindEvents(); } catch (e) { derr('bindEvents failed', e); }
  initApp().catch(e => derr('initApp failed', e));
  registerSW();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
