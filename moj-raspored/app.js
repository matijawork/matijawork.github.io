// Moj raspored — frontend v2.4.0
// - Single ghWrite() for ALL writes. Fresh SHA right before PUT every attempt. No SHA cache.
// - Per-path mutex serializes concurrent writes → zero races.
// - Black + purple UI. Bottom-sheet modals. Scroll-spy footer. Skeleton loading.
// - Toasts bottom-center (success=green, error=red, info=purple).

const APP_VERSION = '2.4.0';
const DEBUG = true;
const dlog = (...a) => { if (DEBUG) console.log('[mr]', ...a); };
const derr = (...a) => console.error('[mr]', ...a);

const LS = {
  token: 'mr.token',
  queue: 'mr.queue',
};

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
  countdownTimer: null,
};

const $ = id => document.getElementById(id);
const save = (k, v) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
const esc = s => (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

const b64enc = s => btoa(unescape(encodeURIComponent(s)));
const b64dec = b => decodeURIComponent(escape(atob(b)));

function purgeLegacyKeys() {
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
}

// ---------- Toasts ----------

function toast(msg, type = 'info', ms = 3000) {
  const stack = $('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  el.addEventListener('click', () => dismiss());
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const t = setTimeout(dismiss, ms);
  function dismiss() {
    clearTimeout(t);
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }
}
const toastOk  = m => toast(m, 'success', 2500);
const toastErr = m => toast(m, 'error',  4500);

// ---------- Progress + status dot ----------

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
function setDot(kind) {
  const dot = $('status-dot');
  if (!dot) return;
  dot.classList.remove('online','offline','syncing');
  dot.classList.add(kind);
  dot.title = kind;
}
function refreshDot() { setDot(state.online ? 'online' : 'offline'); }

// ---------- GitHub API ----------

class GhError extends Error {
  constructor(status, body) { super(`GitHub ${status}: ${String(body).slice(0,200)}`); this.status = status; this.body = body; }
}

const isNetworkError = e => !(e instanceof GhError) && (e instanceof TypeError || e?.name === 'TypeError');

function authHeaders(extra = {}) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${state.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Cache-Control': 'no-cache',
    ...extra,
  };
}

async function ghGet(path) {
  if (!state.token) { const e = new Error('NO_TOKEN'); e.code = 'NO_TOKEN'; throw e; }
  const url = `https://api.github.com/repos/${FIXED_REPO}/contents/${path}?ref=${FIXED_BRANCH}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) { const e = new GhError(404, 'not found'); throw e; }
  if (!res.ok) throw new GhError(res.status, await res.text().catch(() => ''));
  return res.json();
}

async function fetchFile(name) {
  const data = await ghGet(FILES[name]);
  return { content: b64dec(data.content.replace(/\n/g, '')), sha: data.sha };
}

// SINGLE WRITE PATH. NO SHA CACHE. Fresh GET immediately before each PUT attempt.
async function ghWrite(path, content, message) {
  console.log('[ghWrite] token len:', state.token?.length, 'path:', path, 'origin:', location.origin);
  if (!state.token) { const e = new Error('NO_TOKEN'); e.code = 'NO_TOKEN'; throw e; }
  const url = `https://api.github.com/repos/${FIXED_REPO}/contents/${path}`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    let sha;
    const getRes = await fetch(`${url}?ref=${FIXED_BRANCH}`, { headers: authHeaders() });
    if (getRes.ok) sha = (await getRes.json()).sha;
    else if (getRes.status !== 404) {
      throw new GhError(getRes.status, await getRes.text().catch(() => ''));
    }

    const body = { message, content: b64enc(content), branch: FIXED_BRANCH };
    if (sha) body.sha = sha;

    dlog(`PUT ${path} attempt ${i+1}/3 sha=${sha ? sha.slice(0,7) : 'new'}`);
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (putRes.ok) return putRes.json();
    if (putRes.status === 409 || putRes.status === 422) {
      lastErr = new GhError(putRes.status, await putRes.text().catch(() => ''));
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
      continue;
    }
    throw new GhError(putRes.status, await putRes.text().catch(() => ''));
  }
  throw lastErr || new Error('409 nakon 3 pokušaja — refresh stranicu');
}

// ---------- Mutex (serialize writes per file) ----------

const mutex = Object.create(null);
function runExclusive(key, fn) {
  const prev = mutex[key] || Promise.resolve();
  const task = prev.catch(() => {}).then(fn);
  mutex[key] = task;
  return task;
}

// ---------- Offline queue ----------

function enqueue(op) {
  state.queue.push(op);
  save(LS.queue, state.queue);
}
async function flushQueue() {
  if (!state.online || !state.token || state.queue.length === 0) return;
  startSync();
  const keep = [];
  for (const op of state.queue) {
    try { await runExclusive(op.name, () => ghWrite(FILES[op.name], op.content, op.message)); }
    catch (e) {
      if (isNetworkError(e)) keep.push(op);
      else derr('flushQueue drop (API err):', e.message);
    }
  }
  state.queue = keep;
  save(LS.queue, state.queue);
  endSync();
}

// ---------- Single sync() entry point ----------

async function sync(name, content, message) {
  if (!state.online) {
    enqueue({ name, content, message });
    toast('Offline — u queueu', 'info');
    return { queued: true };
  }
  startSync();
  try {
    await runExclusive(name, () => ghWrite(FILES[name], content, message));
    return { ok: true };
  } catch (e) {
    if (isNetworkError(e)) {
      enqueue({ name, content, message });
      toast('Offline — u queueu', 'info');
      return { queued: true };
    }
    if (e.code === 'NO_TOKEN' || e.status === 401) {
      toastErr('Token nedostaje ili je istekao.');
      openDialog('settings-dialog', 'Unesi/obnovi token.');
    } else {
      toastErr('Sync fail: ' + (e.message || e));
    }
    throw e;
  } finally {
    endSync();
  }
}

// ---------- Skeleton helpers ----------

function skeletonRows(n, cls = 'skel-row') {
  return Array.from({length:n}, () => `<div class="${cls}"></div>`).join('');
}

// ---------- Plan + Danas ----------

async function loadPlan() {
  try {
    startSync();
    $('danas-checklist').innerHTML = skeletonRows(4);
    const { content } = await fetchFile('plan');
    state.cache.plan = content;
    renderHero(content);
    renderRaspored();
    renderDanas(content);
    scheduleCountdown();
  } catch (e) {
    if (e.status === 404) {
      state.cache.plan = '';
      renderHero('');
      renderRaspored();
      renderDanas('');
      toast('PLAN.md ne postoji (dnevna rutina generira).', 'info');
    } else {
      toastErr('Plan: ' + e.message);
      if (e.status === 401 || e.code === 'NO_TOKEN') openDialog('settings-dialog', 'Unesi token.');
    }
  } finally { endSync(); }
}

function renderHero(md) {
  const h1 = md.match(/^#\s+(.+)$/m);
  const smjena = md.match(/Smjena:\s*([^\n(]+)\s*\(([^)]+)\)/i);
  const d = new Date();
  const datum = d.toLocaleDateString('hr-HR', { weekday:'long', day:'numeric', month:'long' });
  $('hero-date').textContent = datum;
  $('hero-title').textContent = h1 ? h1[1] : 'Plan';
  if (smjena) {
    $('hero-smjena').textContent = `${smjena[1].trim()} · ${smjena[2].trim()}`;
    $('hero-smjena').hidden = false;
  } else {
    $('hero-smjena').hidden = true;
  }
  renderCountdown();
}

function renderCountdown() {
  const el = $('hero-countdown');
  if (!el) return;
  const events = parseRasporedTable(state.cache.plan || '');
  const now = new Date();
  const nowM = now.getHours()*60 + now.getMinutes();
  const next = events.find(e => e.startM > nowM);
  if (!next) { el.textContent = ''; return; }
  const diff = next.startM - nowM;
  const label = next.label.length > 30 ? next.label.slice(0, 28) + '…' : next.label;
  if (diff < 60) el.textContent = `Za ${diff} min: ${label}`;
  else el.textContent = `Za ${Math.floor(diff/60)}h ${diff%60}min: ${label}`;
}
function scheduleCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(renderCountdown, 60_000);
}

function renderDanas(md) {
  const el = $('danas-checklist');
  const sect = md.match(/##\s*Checklist\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!sect) { el.innerHTML = '<p class="empty">Nema checkliste u planu.</p>'; return; }
  const lines = sect[1].split('\n').filter(l => /^-\s+\[/.test(l));
  if (!lines.length) { el.innerHTML = '<p class="empty">Nema stavki.</p>'; return; }
  el.innerHTML = marked.parse(lines.join('\n'));
  bindDanasCheckboxes();
}

function bindDanasCheckboxes() {
  $('danas-checklist').querySelectorAll('input[type=checkbox]').forEach((cb, idx) => {
    cb.disabled = false;
    const li = cb.closest('li');
    if (li && cb.checked) li.classList.add('done');
    cb.addEventListener('change', () => {
      if (li) li.classList.toggle('done', cb.checked);
      toggleDanas(idx, cb.checked);
    });
  });
}

async function toggleDanas(sectionIdx, checked) {
  let md;
  try { md = (await fetchFile('plan')).content; }
  catch (e) { toastErr('Ne mogu pročitati plan.'); return; }

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

  try { await sync('plan', updated, `plan: toggle #${sectionIdx}`); toastOk('Spremljeno'); }
  catch (e) { await loadPlan(); }
}

// ---------- Timeline ----------

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

  const events = parseRasporedTable(state.cache.plan || '');
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'empty timeline-empty';
    empty.textContent = state.cache.plan ? 'Nema stavki.' : 'Plan još nije generiran.';
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
    list.innerHTML = `
      <li class="empty">
        <span class="empty-icon">∅</span>
        <span>Još nema zadataka.</span>
        <span class="empty-cta">Dodaj prvi gore ↑</span>
      </li>`;
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
      <span class="chip chip-${safeTagKey}"></span>
      <span class="text"></span>
      <button class="del" aria-label="Obriši">✕</button>
    `;
    li.querySelector('.chip').textContent = t.tag;
    li.querySelector('.text').textContent = t.text;
    li.querySelector('.del').addEventListener('click', () => deleteTask(t, li));
    list.appendChild(li);
  }
}

async function loadZadaci() {
  const list = $('zadaci-list');
  list.innerHTML = skeletonRows(3, 'skel-task');
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
    const marker = /(## Aktivni zadaci\s*\n(?:<!--[^>]*-->\s*\n)?)/;
    const updated = marker.test(md)
      ? md.replace(marker, m => `${m}- [ ] ${tag} ${text}\n`)
      : md.trimEnd() + `\n## Aktivni zadaci\n- [ ] ${tag} ${text}\n`;
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
    if (!removed) { toast('Zadatak nije pronađen.', 'info'); return loadZadaci(); }
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

// ---------- Preferences & Context ----------

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
  } catch (e) {}
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

// ---------- Scroll spy ----------

function setupScrollSpy() {
  const sections = ['section-raspored', 'section-danas', 'section-zadaci'].map(id => $(id)).filter(Boolean);
  const indicator = $('spy-indicator');
  if (!indicator || !sections.length) return;

  const onScroll = () => {
    const y = window.scrollY + window.innerHeight * 0.35;
    let idx = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= y) idx = i;
    }
    const pct = (idx + 0.5) / sections.length;
    indicator.style.left = `calc(${pct * 100}% - 12px)`;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ---------- SW ----------

async function registerSW() {
  console.log('[mr-boot] protocol:', location.protocol, 'origin:', location.origin, 'token len:', state.token?.length || 0);

  if (location.protocol === 'file:') {
    toastErr('Otvaraš s file:// — GitHub API blokiran. Otvori https://matijawork.github.io/moj-raspored/');
    console.error('[mr-boot] file:// protocol → fetch ce failati (Failed to fetch). Otvori kroz https.');
    return;
  }

  if (!('serviceWorker' in navigator)) return;

  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    console.log('[mr-boot] SW registrations found:', regs.length);
    for (const r of regs) {
      const scriptURL = r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL;
      console.log('[mr-boot] SW scope:', r.scope, 'script:', scriptURL);
    }
    const params = new URLSearchParams(location.search);
    if (params.get('nuke') === '1') {
      console.warn('[mr-boot] NUKE mode: unregister all SWs + clear caches');
      await Promise.all(regs.map(r => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      toast('SW + cache obrisani — reload za 1s', 'info');
      setTimeout(() => location.replace(location.pathname), 1000);
      return;
    }
  } catch (e) {
    console.error('[mr-boot] SW introspection fail:', e);
  }

  navigator.serviceWorker.register('sw.js').then(r => {
    console.log('[mr-boot] SW register OK, scope:', r.scope);
    r.update().catch(() => {});
  }).catch(e => console.error('[mr-boot] SW register fail:', e));
}

// ---------- Init ----------

function bindEvents() {
  $('refresh-btn').addEventListener('click', () => { loadPlan(); loadZadaci(); });
  $('hero').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

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
  setupScrollSpy();
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
