(function () {
  'use strict';
  const E = window.PlannerEngine, P = window.LogParse, D = window.DayPlan;
  const CAL = 'Google Calendar';
  const LOG_MARK = "Logged in Harvey's Logbook";
  const PLAN_MARK = "Planned in Harvey's Logbook";
  // Projects sit in folders so coursework and extracurricular work share one list.
  const FOLDERS = ['University', 'Career', 'Extracurricular'];
  // Priority is an Eisenhower matrix: urgency comes from deadlines and the
  // forecast, importance from Harvey (normal unless he marks a task high or low).
  const QUADS = {
    do: { label: 'Do first', pill: 'crit', why: 'Due or needs starting within days, or forecast late.' },
    plan: { label: 'Schedule', pill: 'info', why: 'Matters, no rush yet: give it planned time.' },
    fit: { label: 'Fit in', pill: 'warn', why: 'Due soon but low importance: squeeze it into a gap.' },
    later: { label: 'Later', pill: 'plain', why: 'Low importance and no deadline pressure.' },
    wait: { label: 'Waiting', pill: 'plain', why: "A teammate's task you're waiting on." },
  };
  const QORDER = { do: 0, plan: 1, fit: 2, later: 3, wait: 4 };
  const IMP_RANK = { high: 2, normal: 1, low: 0 };
  // The stand-alone app (GitHub Pages) sets this: storage, Google sign-in and
  // sync come from platform.js there instead of claude.ai.
  const SA = !!window.LOGBOOK_STANDALONE;
  const PF = SA ? window.LogbookPlatform : null;
  const NO_DB = SA ? "This browser isn't letting the Logbook save on this device." : 'This logbook saves only when it is open in claude.ai.';
  const AI = SA ? window.LocalAI : null;

  // ---------- helpers ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d) => { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const hm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
  const minOfDay = (d) => d.getHours() * 60 + d.getMinutes();
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : null; };
  const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function fmtMin(m) {
    if (m == null || !isFinite(m)) return '–';
    m = Math.round(m);
    const h = Math.floor(m / 60), r = m % 60;
    return h ? (r ? h + 'h ' + r + 'm' : h + 'h') : r + 'm';
  }
  const fmtH = (h) => (h == null || !isFinite(h) ? '–' : fmtMin(h * 60));
  function dayName(s, o) {
    if (!s) return '';
    return new Date(s + 'T12:00:00').toLocaleDateString('en-GB', o || { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return 'on ' + dayName(localDate(new Date(t)));
  }
  const isMine = (t) => !t.owner || t.owner === 'me';
  const isOpen = (t) => t.status !== 'done' && t.status !== 'dropped';
  const impRank = (t) => IMP_RANK[t.importance] ?? 1;

  // Sheffield 2026–27 teaching calendar, for the week label.
  const TERMS = [
    ['2026-09-28', '2026-12-19', 'Autumn', 1],
    ['2026-12-20', '2027-01-17', 'Winter break', 0],
    ['2027-01-18', '2027-02-06', 'January exams', 0],
    ['2027-02-08', '2027-03-20', 'Spring', 1],
    ['2027-03-21', '2027-04-11', 'Easter break', 0],
    ['2027-04-12', '2027-06-12', 'Spring', 7],
  ];
  function termLabel(date) {
    for (const [a, b, name, w0] of TERMS) {
      if (date >= a && date <= b) return w0 ? name + ' wk ' + (Math.floor(E.daysBetween(a, date) / 7) + w0) : name;
    }
    return '';
  }

  const DEFAULTS = {
    weekHours: [3, 3, 3, 3, 3, 4, 3],
    overrides: {},
    dayStart: '08:30', dayEnd: '22:00', bufferMin: 10, minBlockMin: 25,
    busyCalendars: [],
    logCalendarId: '',
    logToCalendar: true,
    logColorId: '8',
    planToCalendar: true,
    planColorId: '9',
    categories: ['CAD', 'Analysis', 'Coding', 'Writing', 'Making', 'Admin', 'Reading', 'Meeting'],
    quantile: 'p50',
    askClaude: true,
    useLearnedFactor: true,
  };
  const SLOT_NAMES = ['Blue', 'Orange', 'Aqua', 'Yellow', 'Pink', 'Green', 'Violet', 'Red'];
  const GCOLORS = [['1', 'Lavender'], ['2', 'Sage'], ['3', 'Grape'], ['4', 'Flamingo'], ['5', 'Banana'], ['6', 'Tangerine'], ['7', 'Peacock'], ['8', 'Graphite'], ['9', 'Blueberry'], ['10', 'Basil'], ['11', 'Tomato']];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const VIEWS = SA ? ['today', 'tasks', 'timeline', 'insights', 'analyze', 'setup'] : ['today', 'tasks', 'timeline', 'insights', 'setup'];

  // ---------- state ----------
  const S = {
    db: null, mcp: null, sample: null, downloads: null, offline: false, dbError: null, readOnly: false,
    got: { projects: false, tasks: false, logs: false, settings: false },
    projects: [], tasks: [], logs: [], settings: Object.assign({}, DEFAULTS), timer: null, plans: {},
    tx: {}, loggedByTask: {}, todayUsed: 0, calib: null, fc: null, fcError: null, factorInfo: null, critSet: new Set(),
    today: localDate(),
    view: 'today', planDay: null, planDayFor: null, busy: {}, quad: {}, boardQ: 'all',
    filter: { project: 'all', status: 'open', q: '', sort: 'priority' },
    tl: { weeks: 8, quantile: null },
    draft: { parsed: null, over: {}, timer: null },
    calendars: null, lastProj: '', tips: [], pending: false,
    analyses: {}, an: { taskId: null, run: null, err: null }, ai: null,
  };
  const loaded = () => S.offline || (S.got.projects && S.got.tasks && S.got.logs && S.got.settings);
  const projById = (id) => S.projects.find((p) => p.id === id);
  const archivedSet = () => new Set(S.projects.filter((p) => p.active === false).map((p) => p.id));
  const byOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.name || a.title || '').localeCompare(String(b.name || b.title || ''));
  const folderRank = (p) => { const i = FOLDERS.indexOf(p && p.folder); return i < 0 ? FOLDERS.length : i; };
  const byFolder = (a, b) => folderRank(a) - folderRank(b) || byOrder(a, b);
  const activeProjects = () => S.projects.filter((p) => p.active !== false).sort(byFolder);
  function pc(p) {
    if (!p) return 'var(--faint)';
    let slot = Number(p.color);
    if (!(slot >= 1 && slot <= 8)) slot = (S.projects.slice().sort(byOrder).indexOf(p) % 8) + 1;
    return 'var(--s' + slot + ')';
  }
  const projName = (id) => { const p = projById(id); return p ? p.short || p.name : 'No project'; };
  function mergeSettings(doc) {
    const s = Object.assign({}, DEFAULTS, doc || {});
    if (!Array.isArray(s.weekHours) || s.weekHours.length !== 7) s.weekHours = DEFAULTS.weekHours.slice();
    if (!Array.isArray(s.categories)) s.categories = DEFAULTS.categories.slice();
    if (!Array.isArray(s.busyCalendars)) s.busyCalendars = [];
    s.overrides = Object.assign({}, s.overrides || {});
    return s;
  }

  // ---------- database ----------
  const queues = {};
  function write(path, fn) {
    if (!S.db) { toast(NO_DB, { bad: true }); return Promise.reject({ code: 'no_db' }); }
    const run = async () => {
      try { return await fn(S.db.doc(path)); }
      catch (e) {
        if (e && e.code === 'unavailable') { await new Promise((r) => setTimeout(r, 500 + Math.random() * 700)); return fn(S.db.doc(path)); }
        throw e;
      }
    };
    const p = (queues[path] || Promise.resolve()).catch(() => {}).then(run);
    queues[path] = p;
    return p.catch((e) => { dbFail(e); throw e; });
  }
  function dbFail(e) {
    const code = e && e.code;
    if (code === 'no_db') return;
    const copy = {
      invalid_argument: "Couldn't save that change. If this keeps happening, you may only have view access to this logbook.",
      quota_exceeded: SA ? "This device's storage is full. Free up some space, then try again." : 'The logbook database is full. Ask Claude in chat to archive old logs.',
      resource_exhausted: 'Too many changes at once. Wait a moment and try again.',
      revoked: 'Access to this logbook changed. Reload the page.',
    }[code] || "Couldn't save (" + (code || 'unknown error') + '). Try again.';
    toast(copy, { bad: true });
  }
  function subscribe() {
    const db = S.db;
    const onErr = (what) => (e) => { S.dbError = (e && e.code) || 'unavailable'; console.warn('db', what, e); render(); };
    const rows = (snap) => snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    db.collection('projects').onSnapshot((s) => { S.projects = rows(s); S.got.projects = true; changed(); }, onErr('projects'));
    db.collection('tasks').onSnapshot((s) => { S.tasks = rows(s); S.got.tasks = true; changed(); }, onErr('tasks'));
    db.collection('logs').orderBy('date', 'desc').limit(1000).onSnapshot((s) => { S.logs = rows(s); S.got.logs = true; changed(); }, onErr('logs'));
    db.doc('settings/main').onSnapshot((d) => {
      S.settingsDoc = d.exists ? Object.assign({}, d.data()) : null;
      S.settings = mergeSettings(S.settingsDoc);
      S.got.settings = true;
      changed();
    }, onErr('settings'));
    db.doc('timer/current').onSnapshot((d) => {
      const t = d.exists ? d.data() : null;
      S.timer = t && t.startedAt ? Object.assign({}, t) : null;
      renderTimer();
    }, onErr('timer'));
    db.collection('plans').orderBy('date', 'desc').limit(14).onSnapshot((s) => {
      S.plans = {};
      s.docs.forEach((d) => { S.plans[d.id] = d.data(); });
      changed();
    }, onErr('plans'));
    if (SA) db.collection('analyses').onSnapshot((s) => {
      S.analyses = {};
      s.docs.forEach((d) => { S.analyses[d.id] = d.data(); });
      if (S.view === 'analyze') render();
    }, onErr('analyses'));
  }
  let saveSettingsT = null;
  function saveSettings(patch) {
    S.settings = mergeSettings(Object.assign({}, S.settings, patch));
    S.settingsDoc = Object.assign({}, S.settingsDoc || {}, patch);
    clearTimeout(saveSettingsT);
    saveSettingsT = setTimeout(() => {
      const body = Object.assign({}, S.settingsDoc, { updatedAt: new Date().toISOString() });
      // keep only recent day overrides
      const cutoff = E.addDays(localDate(), -14);
      if (body.overrides) body.overrides = Object.fromEntries(Object.entries(body.overrides).filter(([d]) => d >= cutoff));
      write('settings/main', (ref) => ref.set(body)).catch(() => {});
    }, 350);
    changed();
  }

  // ---------- connectors ----------
  function calCopy(e) {
    const code = e && e.code;
    if (SA) {
      return ({
        needs_reauth: 'Google sign-in has lapsed. Tap the sync button at the top to sign in, then try again.',
        popup_blocked: 'The browser blocked the Google sign-in window. Allow pop-ups for this site, then try again.',
        not_granted: "Google didn't give the Logbook calendar access. Sign out in Setup, sign in again and tick every box.",
        wrong_account: String((e && e.message) || 'That is a different Google account from the one this device syncs with.'),
        not_configured: 'Google sign-in is not set up in this copy of the app.',
        offline: "You're offline, so it couldn't reach Google Calendar.",
        tool_error: 'Google Calendar refused: ' + String((e && e.message) || '').slice(0, 140),
        server_unavailable: "Couldn't reach Google Calendar. Check the connection and try again.",
        upstream_error: "Google Calendar didn't answer. Try again in a moment.",
      })[code] || 'Calendar call failed (' + (code || 'unknown') + ').';
    }
    return ({
      needs_reauth: 'Reconnect Google Calendar in claude.ai Settings → Connectors.',
      server_not_connected: 'Add Google Calendar in claude.ai Settings → Connectors.',
      selection_required: 'Pick which Google Calendar connector this page should use when claude.ai asks.',
      not_in_manifest: "Calendar access is off for this page. Turn it on in this page's Permissions menu.",
      approval_required: 'Google Calendar needs your approval. Try again and choose Allow.',
      blocked_by_policy: 'Your organisation blocks this calendar action.',
      tool_error: 'Google Calendar refused: ' + String((e && e.message) || '').slice(0, 140),
      server_unavailable: "Google Calendar didn't answer. Try again in a moment.",
      upstream_error: "Google Calendar didn't answer. Try again in a moment.",
      not_granted: 'Calendar access is off for this page.',
      capability_disabled: "Calendar isn't available in this view.",
    })[code] || 'Calendar call failed (' + (code || 'unknown') + ').';
  }
  async function calRead(tool, input) {
    if (!S.mcp) throw { code: 'capability_disabled' };
    try { return await S.mcp.callTool(CAL, tool, input); }
    catch (e) {
      if (e && e.retryable) {
        await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs || 900, 4000) + Math.random() * 400));
        return S.mcp.callTool(CAL, tool, input);
      }
      throw e;
    }
  }
  function eventIdFrom(p) {
    if (!p) return null;
    if (typeof p === 'string') { const m = p.match(/"id"\s*:\s*"([^"]+)"/); return m ? m[1] : null; }
    return p.id || (p.event && p.event.id) || p.eventId || null;
  }

  // ---------- derived data ----------
  let changeT = null;
  function changed() {
    clearTimeout(changeT);
    changeT = setTimeout(() => { recompute(); render(); renderPreview(); }, 25);
  }
  function quantile() { return S.tl.quantile || S.settings.quantile || 'p50'; }
  function engineSettings() {
    const s = S.settings;
    const f = s.useLearnedFactor && S.factorInfo ? Math.min(1.3, Math.max(0.5, S.factorInfo.factor)) : 1;
    return { weekHours: s.weekHours.map((h) => num(h) || 0), overrides: s.overrides || {}, factor: f };
  }
  function learnedFactor() {
    if (!S.logs.length) return null;
    const first = S.logs.reduce((a, l) => (l.date && l.date < a ? l.date : a), S.today);
    const yesterday = E.addDays(S.today, -1);
    let from = E.addDays(S.today, -28);
    if (first > from) from = first;
    if (from > yesterday) return null;
    return E.capacityFactor(
      S.logs.map((l) => ({ date: l.date, minutes: l.minutes || 0 })),
      { weekHours: S.settings.weekHours.map((h) => num(h) || 0), overrides: S.settings.overrides || {} },
      from, yesterday, 14
    );
  }
  function recompute() {
    S.today = localDate();
    const today = S.today;
    const archived = archivedSet();
    const logged = {};
    let todayUsed = 0;
    for (const l of S.logs) {
      const h = (l.minutes || 0) / 60;
      if (l.taskId) logged[l.taskId] = (logged[l.taskId] || 0) + h;
      if (l.date === today) todayUsed += h;
    }
    S.loggedByTask = logged;
    S.todayUsed = todayUsed;
    S.tx = {};
    const tasks = [];
    for (const t of S.tasks) {
      const x = Object.assign({}, t, {
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
        actualH: (num(t.actualH) || 0) + (logged[t.id] || 0),
        estimateH: num(t.estimateH),
        deadline: t.deadline || null,
        notBefore: t.notBefore || null,
      });
      S.tx[t.id] = x;
      if (!archived.has(t.projectId)) tasks.push(x);
    }
    S.calib = E.calibrate(tasks.map((t) => Object.assign({}, t, { estimateH: ownEstimate(t) })));
    S.factorInfo = learnedFactor();
    // late in the day the clock, not the daily target, limits what's left
    const usedEff = Math.max(todayUsed, dayTarget(today) - hoursLeftToday());
    try {
      S.fc = E.forecast({ tasks, projects: activeProjects(), today, settings: engineSettings(), calibration: S.calib, quantile: quantile(), todayUsed: usedEff });
      S.fcError = null;
    } catch (e) {
      S.fc = null;
      S.fcError = String((e && e.message) || e);
      console.error(e);
    }
    S.critSet = new Set();
    if (S.fc) for (const id in S.fc.projects) {
      const cp = S.fc.projects[id].criticalPath;
      if (cp && cp.taskIds.length > 1) cp.taskIds.forEach((t) => S.critSet.add(t));
    }
    S.quad = {};
    for (const t of S.tasks) { const q = quadOf(t); if (q) S.quad[t.id] = q; }
  }
  // the first estimate Harvey made himself; Claude's guesses don't train calibration
  function ownEstimate(t) {
    if (t.estimateBy === 'claude') return null;
    return num(t.estimateH0) != null ? num(t.estimateH0) : num(t.estimateH);
  }
  function dayTarget(date) {
    const o = S.settings.overrides || {};
    if (date in o) return num(o[date]) || 0;
    return num(S.settings.weekHours[E.weekday(date)]) || 0;
  }
  function hoursLeftToday() {
    const s = S.settings;
    const a = D.toMin(s.dayStart || '08:30'), b = D.toMin(s.dayEnd || '22:00');
    const left = Math.max(0, b - Math.max(minOfDay(new Date()), a));
    // a sliver shorter than a useful slot isn't time to plan work into
    return left < (num(s.minBlockMin) ?? 25) ? 0 : left / 60;
  }
  // In the last hour before the day ends, with no planned work still to come,
  // Today looks at tomorrow instead.
  function eveningNow() {
    const now = minOfDay(new Date());
    if (now < D.toMin(S.settings.dayEnd || '22:00') - 60) return false;
    const plan = S.plans[S.today];
    return !(plan && (plan.blocks || []).some((b) => D.toMin(b.end) > now));
  }
  function planDayEff() {
    if (S.planDay && S.planDayFor === S.today) return S.planDay;
    return eveningNow() ? 'tomorrow' : 'today';
  }
  function quadOf(t) {
    if (!isOpen(t)) return null;
    if (!isMine(t)) return 'wait';
    const f = S.fc && S.fc.tasks[t.id];
    const today = S.today;
    let urgent;
    if (f) {
      urgent = !!f.late ||
        (!!f.deadline && f.deadline <= E.addDays(today, f.softDeadline ? 3 : 7)) ||
        (!!f.latestStart && f.latestStart <= E.addDays(today, 3));
    } else urgent = !!t.deadline && t.deadline <= E.addDays(today, 7);
    const low = t.importance === 'low';
    if (urgent) return low ? 'fit' : 'do';
    return low ? 'later' : 'plan';
  }
  function quadPill(id) {
    const q = QUADS[S.quad[id]];
    return q ? `<span class="pill ${q.pill}" title="${esc(q.why)}">${esc(q.label)}</span>` : '';
  }
  function impOptions(sel) {
    sel = sel || 'normal';
    return opt('high', 'High', sel) + opt('normal', 'Normal', sel) + opt('low', 'Low', sel);
  }

  // ---------- rendering ----------
  function editingInView() {
    const a = document.activeElement;
    if (!a || !$('#view').contains(a)) return false;
    if (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
    return a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(a.type);
  }
  function render() {
    const act = document.activeElement;
    const qaddProj = act && act.matches && act.matches('.qadd input') && !act.value ? act.closest('.qadd').dataset.proj : null;
    $('#termLabel').textContent = [termLabel(S.today), dayName(S.today, { weekday: 'long', day: 'numeric', month: 'long' })].filter(Boolean).join(' · ');
    $$('#tabs .tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.view)));
    const open = S.tasks.filter((t) => isOpen(t) && !archivedSet().has(t.projectId)).length;
    $('#taskCount').textContent = open ? String(open) : '';
    if (editingInView() && qaddProj == null) {
      S.pending = true;
      // typing in the add row or search box: the sheet below can still refresh
      const host = $('#sheetHost');
      if (S.view === 'tasks' && host && !host.contains(document.activeElement)) refreshSheet();
      return;
    }
    S.pending = false;
    S.tips = [];
    const v = $('#view');
    v.setAttribute('aria-labelledby', 'tab-' + S.view);
    v.innerHTML = banners() + (loaded() ? viewHtml() : '<p class="loading">Opening your logbook…</p>');
    if (S.view === 'tasks') fitTitles();
    if (qaddProj != null) { const i = $('.qadd[data-proj="' + qaddProj + '"] input'); if (i) i.focus(); }
    if (S.view === 'tasks') { const q = $('#fQ'); if (q && S.focusSearch) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); S.focusSearch = false; } }
  }
  function banners() {
    const b = [];
    if (S.offline) b.push('<div class="banner">Open this logbook in claude.ai while signed in to save logs and tasks. Nothing typed here is kept.</div>');
    if (SA) b.push(saBanners());
    if (S.dbError) b.push('<div class="banner bad">The logbook lost its connection to its database (' + esc(S.dbError) + '). Reload the page.</div>');
    if (S.fcError) b.push('<div class="banner bad">The schedule could not be worked out: ' + esc(S.fcError) + '</div>');
    return b.join('');
  }
  function viewHtml() {
    switch (S.view) {
      case 'tasks': return viewTasks();
      case 'timeline': return viewTimeline();
      case 'insights': return viewInsights();
      case 'analyze': return SA ? viewAnalyze() : viewToday();
      case 'setup': return viewSetup();
      default: return viewToday();
    }
  }
  function opt(value, label, sel) { return '<option value="' + esc(value) + '"' + (value === sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  function projectOptions(sel, withNone, short) {
    let h = withNone ? opt('', 'No project', sel || '') : '';
    for (const p of activeProjects()) h += opt(p.id, short ? p.short || p.name : p.name, sel);
    const cur = projById(sel);
    if (sel && cur && cur.active === false) h += opt(cur.id, cur.name + ' (archived)', sel);
    return h;
  }
  function categoryOptions(sel) {
    const cats = S.settings.categories.slice();
    if (sel && !cats.includes(sel)) cats.push(sel);
    return opt('', '–', sel || '') + cats.map((c) => opt(c, c, sel)).join('');
  }
  function projTag(id) {
    const p = projById(id);
    return '<span class="proj"><i class="swatch" style="background:' + pc(p) + '"></i>' + esc(p ? p.short || p.name : 'No project') + '</span>';
  }
  function tip(title, lines) { S.tips.push({ title, lines }); return S.tips.length - 1; }

  // ----- Today -----
  function viewToday() {
    const today = S.today;
    const pd = planDayEff();
    const date = pd === 'tomorrow' ? E.addDays(today, 1) : today;
    const plan = S.plans[date];
    const target = dayTarget(date);
    const stats = [['Logged today', fmtH(S.todayUsed)], [date === today ? 'Project time' : 'Project time tomorrow', fmtH(target)]];
    if (plan) stats.push(['Free in calendar', fmtH(plan.freeH)]);
    const autoEvening = pd === 'tomorrow' && !(S.planDay && S.planDayFor === today);
    const onCal = plan && (plan.calEvents || []).length;
    const head = `
      <section class="day-head">
        <div>
          <p class="eyebrow">${esc(termLabel(date) || 'Day')} · ${esc(dayName(date, { weekday: 'long' }))}${date !== today ? ' · tomorrow' : ''}</p>
          <h2>${esc(dayName(date, { day: 'numeric', month: 'long' }))}</h2>
        </div>
        <dl class="day-stats">${stats.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      </section>
      ${autoEvening ? `<p class="evening">It's ${esc(hm(new Date()))}, so today is wrapped up and this shows tomorrow. ${S.todayUsed ? 'You logged ' + esc(fmtH(S.todayUsed)) + ' today.' : 'Log anything you did today in the box above.'}</p>` : ''}
      <div class="plan-bar">
        <div class="seg" role="group" aria-label="Day to plan">
          <button type="button" data-act="planday" data-day="today" aria-pressed="${pd !== 'tomorrow'}">Today</button>
          <button type="button" data-act="planday" data-day="tomorrow" aria-pressed="${pd === 'tomorrow'}">Tomorrow</button>
        </div>
        <div class="stepper" role="group" aria-label="Hours of project work">
          <button type="button" data-act="target" data-d="-0.5" data-date="${date}" aria-label="Half an hour less">−</button>
          <output>${esc(fmtH(target))}</output>
          <button type="button" data-act="target" data-d="0.5" data-date="${date}" aria-label="Half an hour more">+</button>
        </div>
        <button type="button" class="btn primary" data-act="plan" data-date="${date}" ${S.busy.plan ? 'disabled' : ''}>${S.busy.plan ? 'Planning…' : plan ? 'Re-plan' : date === today ? 'Plan my day' : 'Plan tomorrow'}</button>
        <span class="muted">${plan ? 'Planned ' + esc(timeAgo(plan.createdAt)) + (plan.calendarsRead ? ' from ' + plan.calendarsRead + ' calendar' + (plan.calendarsRead === 1 ? '' : 's') : '') + (onCal ? ', and on your calendar' : '') + '.' : 'Reads your calendars and fills the free time from your priorities' + (S.settings.planToCalendar ? ', then puts the plan on your calendar.' : '.')}</span>
      </div>
      ${plan && plan.calendarErrors && plan.calendarErrors.length ? `<div class="banner">${plan.calendarErrors.map(esc).join('<br>')}</div>` : ''}`;
    return head + `<div class="day-grid">
        <section class="panel p-agenda">${agendaHtml(date, plan)}</section>
        <div class="stack">
          ${plan ? `<section class="panel p-plan">${planListHtml(date, plan)}</section>` : ''}
          <section class="panel p-logged">${loggedTodayHtml()}</section>
          <section class="panel p-attn">${attentionHtml()}</section>
        </div>
        <section class="panel p-board">${boardHtml()}</section>
      </div>`;
  }
  // Every open task, by folder and project, each with its priority.
  function boardHtml() {
    const archived = archivedSet();
    const open = S.tasks.filter((t) => isOpen(t) && !archived.has(t.projectId));
    const qf = S.boardQ || 'all';
    const counts = { do: 0, plan: 0, fit: 0, later: 0, wait: 0 };
    for (const t of open) counts[S.quad[t.id] || 'plan']++;
    const fct = S.fc ? S.fc.tasks : {};
    const startOf = (t) => (fct[t.id] && fct[t.id].start) || '9999';
    const sortT = (a, b) => (QORDER[S.quad[a.id]] ?? 9) - (QORDER[S.quad[b.id]] ?? 9) || impRank(b) - impRank(a) ||
      startOf(a).localeCompare(startOf(b)) || (a.order ?? 0) - (b.order ?? 0);
    const chip = (q, label, n, cls) => `<button type="button" class="chip" data-act="fquad" data-q="${q}" aria-pressed="${qf === q}">${cls ? `<i class="qdot ${cls}"></i>` : ''}${esc(label)} <b class="num">${n}</b></button>`;
    let h = `<div class="panel-h"><h3>Your tasks</h3><span class="muted">Everything open, by project.</span></div>
      <div class="chips" role="group" aria-label="Show by priority">${chip('all', 'All', open.length)}${['do', 'plan', 'fit', 'later'].map((q) => chip(q, QUADS[q].label, counts[q], QUADS[q].pill)).join('')}${counts.wait ? chip('wait', 'Waiting', counts.wait) : ''}</div>
      <p class="muted method"><b>Do first</b>: due or needs starting within days. <b>Schedule</b>: matters, no rush yet. <b>Fit in</b>: urgent but low importance. <b>Later</b>: neither. Set importance and deadlines on the Tasks tab.</p>`;
    const projs = activeProjects();
    const loose = open.filter((t) => !t.projectId || !projById(t.projectId));
    let any = false;
    for (const folder of FOLDERS.concat(['Other'])) {
      const cards = projs.filter((p) => (FOLDERS.includes(p.folder) ? p.folder : 'Other') === folder)
        .map((p) => cardHtml(p, open.filter((t) => t.projectId === p.id), qf, sortT));
      if (folder === 'Other' && loose.length) cards.push(cardHtml(null, loose, qf, sortT));
      const shown = cards.filter(Boolean);
      if (!shown.length) continue;
      any = true;
      h += `<div class="folder"><h4 class="eyebrow">${esc(folder)}</h4><div class="cards">${shown.join('')}</div></div>`;
    }
    if (!any) h += `<div class="empty">${qf === 'all' ? '<strong>No open tasks.</strong> Add some on the Tasks tab.' : 'No open tasks with this priority.'}</div>`;
    return h;
  }
  function cardHtml(p, ts, qf, sortT) {
    const list = ts.filter((t) => qf === 'all' || S.quad[t.id] === qf).sort(sortT);
    if (qf !== 'all' && !list.length) return '';
    const fct = S.fc ? S.fc.tasks : {};
    const left = ts.reduce((a, t) => a + ((fct[t.id] && fct[t.id].remainingH) || 0), 0);
    const name = p ? p.short || p.name : 'No project';
    let h = `<article class="pcard"><header><span class="proj"><i class="swatch" style="background:${pc(p)}"></i><strong>${esc(name)}</strong></span><span class="muted num">${ts.length ? ts.length + ' open · ' + esc(fmtH(left)) : ''}</span></header>`;
    if (list.length) {
      h += '<ul class="btasks">' + list.map((t) => {
        const f = fct[t.id];
        const due = t.deadline ? 'due ' + dayName(t.deadline) : f && f.deadline && !f.softDeadline ? 'needed by ' + dayName(f.deadline) : '';
        const mine = isMine(t);
        return `<li><input type="checkbox" class="b-done" data-id="${esc(t.id)}" aria-label="Finished: ${esc(t.title)}">
          <div class="bt"><button type="button" class="linkish" data-act="edit" data-id="${esc(t.id)}">${esc(t.title)}</button>
            <div class="s">${quadPill(t.id)}${t.status === 'doing' ? '<span>In progress</span>' : ''}${due ? `<span>${esc(due)}</span>` : ''}${mine && f ? `<span class="num">${esc(fmtH(f.remainingH))}</span>` : ''}${!mine ? `<span>${esc(t.owner)}${t.externalDue ? ', due ' + esc(dayName(t.externalDue)) : ''}</span>` : ''}</div></div>
          ${mine ? `<div class="row-actions"><button type="button" class="btn small ghost" data-act="timer" data-id="${esc(t.id)}">Start</button><button type="button" class="btn small ghost" data-act="prefill" data-id="${esc(t.id)}" data-min="30" data-when="">Log</button></div>` : ''}
        </li>`;
      }).join('') + '</ul>';
    } else h += '<p class="muted none">No open tasks.</p>';
    return h + `<form class="qadd" data-proj="${esc(p ? p.id : '')}" autocomplete="off"><input class="field" name="title" placeholder="Add a task to ${esc(name)}" aria-label="Add a task to ${esc(name)}"></form></article>`;
  }
  function agendaHtml(date, plan) {
    const s = S.settings;
    if (!plan) {
      return `<div class="panel-h"><h3>Day</h3></div>
        <div class="empty"><strong>No plan for ${esc(dayName(date, { weekday: 'long' }))} yet.</strong><br>
        Press <strong>${date === S.today ? 'Plan my day' : 'Plan tomorrow'}</strong>. The logbook reads your calendars, finds the gaps between lectures and shifts, and fills ${esc(fmtH(dayTarget(date)))} of them with the most urgent work.</div>`;
    }
    const evs = (plan.events || []).map((e) => ({ s: D.toMin(e.start), e: D.toMin(e.end), title: e.title, busy: e.busy !== false }));
    const blocks = (plan.blocks || []).map((b) => ({ s: D.toMin(b.start), e: D.toMin(b.end), title: b.title, taskId: b.taskId }));
    let a = D.toMin(s.dayStart), b = D.toMin(s.dayEnd);
    for (const x of evs.concat(blocks)) { a = Math.min(a, Math.floor(x.s / 60) * 60); b = Math.max(b, Math.ceil(x.e / 60) * 60); }
    a = Math.max(0, Math.floor(a / 60) * 60);
    b = Math.min(1440, Math.ceil(b / 60) * 60);
    const PX = 1.05;
    const y = (m) => Math.round((m - a) * PX);
    let h = `<div class="panel-h"><h3>Day</h3><span class="legend"><span><i class="swatch" style="background:var(--accent)"></i>Planned work</span><span><i class="swatch" style="background:var(--faint)"></i>Calendar</span></span></div>`;
    h += `<div class="agenda" style="height:${y(b) + 4}px">`;
    for (let m = a; m <= b; m += 60) h += `<div class="hr" style="top:${y(m)}px"><span>${pad(m / 60)}:00</span></div>`;
    for (const e of evs) {
      const t = tip(e.title, [D.hhmm(e.s) + '–' + D.hhmm(e.e), e.busy ? 'Busy' : "Doesn't block time"]);
      h += `<div class="ev${e.busy ? '' : ' free'}" style="top:${y(e.s)}px;height:${Math.max(18, y(e.e) - y(e.s) - 2)}px" data-tip="${t}"><span class="t">${esc(e.title)}</span><span class="m">${D.hhmm(e.s)}–${D.hhmm(e.e)}</span></div>`;
    }
    for (const k of blocks) {
      const task = S.tx[k.taskId];
      const p = task && projById(task.projectId);
      const t = tip(k.title, [D.hhmm(k.s) + '–' + D.hhmm(k.e) + ' · ' + fmtMin(k.e - k.s), p ? p.name : '']);
      h += `<div class="blk" style="top:${y(k.s)}px;height:${Math.max(18, y(k.e) - y(k.s) - 2)}px;border-left-color:${pc(p)}" data-tip="${t}"><span class="t">${esc(k.title)}</span><span class="m">${D.hhmm(k.s)}–${D.hhmm(k.e)}</span></div>`;
    }
    if (date === S.today) {
      const n = minOfDay(new Date());
      if (n >= a && n <= b) h += `<div class="now" style="top:${y(n)}px" aria-label="Now"></div>`;
    }
    return h + '</div>';
  }
  function planListHtml(date, plan) {
    const rows = (plan.blocks || []).map((b) => ({ when: b.start + '–' + b.end, id: b.taskId, title: b.title, min: b.minutes }));
    const onCal = (plan.calEvents || []).length;
    let h = `<div class="panel-h"><h3>Plan</h3>${onCal ? `<span class="inline"><span class="muted">On your calendar</span><button type="button" class="btn small ghost" data-act="clearplancal" data-date="${esc(date)}">Remove from calendar</button></span>` : ''}</div>`;
    if (!rows.length) {
      return h + `<div class="empty">${!S.tasks.some(isOpen) ? 'No open tasks to plan.' : plan.availH > 0 ? 'No free gap long enough between your events, so nothing was placed.' : 'No project time left for this day.'}</div>`;
    }
    h += '<ul class="items">';
    for (const r of rows) {
      const t = S.tx[r.id];
      const done = t && t.status === 'done';
      h += `<li class="item${done ? ' is-done' : ''}">
        <span class="when">${esc(r.when || fmtMin(r.min))}</span>
        <div class="what"><div class="t">${esc(t ? t.title : r.title)}</div>
          <div class="s">${t ? projTag(t.projectId) : ''}<span>${esc(fmtMin(r.min))}</span>${t && S.fc && S.fc.tasks[t.id] && S.fc.tasks[t.id].deadline ? `<span>due ${esc(dayName(S.fc.tasks[t.id].deadline))}</span>` : ''}</div></div>
        <div class="row-actions">${t && !done ? `<button type="button" class="btn small" data-act="timer" data-id="${esc(t.id)}">Start</button>
          <button type="button" class="btn small ghost" data-act="prefill" data-id="${esc(t.id)}" data-min="${r.min}" data-when="${esc(r.when)}">Log</button>` : done ? '<span class="pill good">Done</span>' : ''}</div>
      </li>`;
    }
    return h + '</ul>';
  }
  function logRow(l, withDate) {
    const cal = l.calendar;
    let calTxt = '';
    if (cal && cal.ok) calTxt = '<span>On calendar</span>';
    else if (cal && cal.ok === false) calTxt = `<span class="pill warn">Not on calendar</span><button type="button" class="btn small ghost" data-act="recal" data-id="${esc(l.id)}">Retry</button>`;
    return `<li class="item">
      <span class="when">${withDate ? esc(dayName(l.date)) + '<br>' : ''}${esc(l.start || '')}${l.end ? '–' + esc(l.end) : ''}</span>
      <div class="what"><div class="t">${esc(l.title || 'Time logged')}</div>
        <div class="s">${projTag(l.projectId)}<span class="num">${esc(fmtMin(l.minutes))}</span>${l.done ? '<span class="pill good">Finished</span>' : ''}${calTxt}</div></div>
      <div class="row-actions"><button type="button" class="btn small ghost danger" data-act="dellog" data-id="${esc(l.id)}">Delete</button></div>
    </li>`;
  }
  function loggedTodayHtml() {
    const ls = S.logs.filter((l) => l.date === S.today).sort((a, b) => String(b.start).localeCompare(String(a.start)));
    let h = `<div class="panel-h"><h3>Logged today</h3><span class="num muted">${esc(fmtH(S.todayUsed))}</span></div>`;
    if (!ls.length) return h + '<div class="empty">Nothing logged yet today. Type what you did in the box at the top, like <strong>gearbox CAD 45 min</strong>.</div>';
    return h + '<ul class="items">' + ls.map((l) => logRow(l, false)).join('') + '</ul>';
  }
  function attentionHtml() {
    const items = [];
    const fc = S.fc;
    if (fc) {
      const late = Object.values(fc.tasks).filter((t) => t.late && t.mine);
      for (const t of late.slice(0, 4)) items.push(`<li><span class="pill crit">Late</span><span><strong>${esc(t.title)}</strong> finishes ${esc(dayName(t.finish) || 'after the horizon')}, deadline ${esc(dayName(t.deadline))}.</span></li>`);
      if (late.length > 4) items.push(`<li><span class="pill crit">Late</span><span>${late.length - 4} more tasks forecast late. See Timeline.</span></li>`);
      const c = fc.crunch.firstShortfall;
      if (c) items.push(`<li><span class="pill crit">Short</span><span>By ${esc(dayName(c.by))} you need ${esc(fmtH(c.needH))} but have ${esc(fmtH(c.haveH))}. Add hours or move a deadline.</span></li>`);
      for (const b of fc.blockedByOthers) items.push(`<li><span class="pill warn">Waiting</span><span>${esc(b.owner)} was due to finish <strong>${esc(b.title)}</strong> on ${esc(dayName(b.due))}. Chase it up.</span></li>`);
      if (fc.cycles.length) items.push(`<li><span class="pill warn">Loop</span><span>${fc.cycles.length} tasks wait on each other in a loop. Fix their “waits on” lists.</span></li>`);
      if (fc.unscheduled.length) items.push(`<li><span class="pill warn">Stuck</span><span>${fc.unscheduled.length} tasks can't be scheduled (they wait on something that never finishes).</span></li>`);
    }
    const noEst = S.tasks.filter((t) => isOpen(t) && isMine(t) && num(t.estimateH) == null && !archivedSet().has(t.projectId)).length;
    if (noEst) items.push(`<li><span class="pill warn">Estimate</span><span>${noEst} open task${noEst === 1 ? ' has' : 's have'} no estimate, so the schedule assumes 1h each. <button type="button" class="btn small ghost" data-act="goto-noest">Add estimates</button></span></li>`);
    const h = '<div class="panel-h"><h3>Needs attention</h3></div>';
    if (!items.length) return h + '<p class="muted">Nothing. Every deadline is on track with your current hours.</p>';
    return h + '<ul class="plain attn">' + items.join('') + '</ul>';
  }

  // ----- Tasks -----
  function viewTasks() {
    const f = S.filter;
    const projs = activeProjects();
    const sel = f.project !== 'all' ? f.project : S.lastProj;
    return `<section class="stack">
      <div class="toolbar">
        <div class="chips" role="group" aria-label="Filter by project">
          <button type="button" class="chip" data-act="fproj" data-id="all" aria-pressed="${f.project === 'all'}">All</button>
          ${projs.map((p) => `<button type="button" class="chip" data-act="fproj" data-id="${esc(p.id)}" aria-pressed="${f.project === p.id}"><i class="swatch" style="background:${pc(p)}"></i>${esc(p.short || p.name)}</button>`).join('')}
        </div>
        <div class="tb-right">
          <select class="field" id="fStatus" aria-label="Show">${opt('open', 'Open', f.status)}${opt('noest', 'Needs estimate', f.status)}${opt('done', 'Done', f.status)}${opt('all', 'All', f.status)}</select>
          <select class="field" id="fSort" aria-label="Sort by">${opt('priority', 'Priority', f.sort)}${opt('plan', 'Plan order', f.sort)}${opt('deadline', 'Deadline', f.sort)}${opt('project', 'By project', f.sort)}</select>
          <input class="field" id="fQ" type="search" placeholder="Search tasks" aria-label="Search tasks" value="${esc(f.q)}">
        </div>
      </div>
      <form class="add-row" id="addTask" autocomplete="off">
        <input class="field grow" id="atTitle" placeholder="Add a task, e.g. Draft a cover letter" aria-label="New task" required>
        <select class="field" id="atProj" aria-label="Project">${projectOptions(sel, true)}</select>
        <input class="field" id="atEst" type="number" min="0" step="0.25" placeholder="Est h" aria-label="Estimate in hours">
        <input class="field" id="atDue" type="date" aria-label="Deadline">
        <button class="btn primary" type="submit">Add task</button>
      </form>
      <div id="sheetHost">${sheetHtml()}</div>
    </section>`;
  }
  function visibleTasks() {
    const f = S.filter;
    const q = f.q.trim().toLowerCase();
    const archived = archivedSet();
    let ts = S.tasks.filter((t) => !archived.has(t.projectId));
    if (f.project !== 'all') ts = ts.filter((t) => t.projectId === f.project);
    if (f.status === 'open') ts = ts.filter(isOpen);
    else if (f.status === 'noest') ts = ts.filter((t) => isOpen(t) && isMine(t) && num(t.estimateH) == null);
    else if (f.status === 'done') ts = ts.filter((t) => t.status === 'done');
    if (q) ts = ts.filter((t) => (t.title || '').toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q));
    const fc = S.fc ? S.fc.tasks : {};
    const projOrder = Object.fromEntries(S.projects.slice().sort(byFolder).map((p, i) => [p.id, i]));
    const created = (t) => (t.order != null ? t.order : Date.parse(t.createdAt) || 0);
    const cmp = {
      plan: (a, b) => {
        const da = a.status === 'done', db = b.status === 'done';
        if (da !== db) return da ? 1 : -1;
        if (da) return String(b.doneAt || '').localeCompare(String(a.doneAt || ''));
        const sa = (fc[a.id] && fc[a.id].start) || '9999', sb = (fc[b.id] && fc[b.id].start) || '9999';
        return sa.localeCompare(sb) || ((fc[a.id] && fc[a.id].finish) || '9999').localeCompare((fc[b.id] && fc[b.id].finish) || '9999') || created(a) - created(b);
      },
      priority: (a, b) => {
        const da = !isOpen(a), db = !isOpen(b);
        if (da !== db) return da ? 1 : -1;
        if (da) return String(b.doneAt || '').localeCompare(String(a.doneAt || ''));
        return (QORDER[S.quad[a.id]] ?? 9) - (QORDER[S.quad[b.id]] ?? 9) || impRank(b) - impRank(a) ||
          ((fc[a.id] && fc[a.id].start) || '9999').localeCompare((fc[b.id] && fc[b.id].start) || '9999') || created(a) - created(b);
      },
      deadline: (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || created(a) - created(b),
      project: (a, b) => (projOrder[a.projectId] ?? 99) - (projOrder[b.projectId] ?? 99) || created(a) - created(b),
    }[f.sort] || (() => 0);
    return ts.sort(cmp);
  }
  function sheetHtml() {
    const ts = visibleTasks();
    if (!S.tasks.length) {
      return SA ? '<div class="empty"><strong>No tasks yet.</strong> Add one above, or bring your logbook in from Setup › Your data › Import a file.</div>'
        : `<div class="empty"><strong>No tasks yet.</strong> Add one above. Claude can also import your team sheets into this list when you share them in chat.</div>`;
    }
    if (!ts.length) return '<div class="empty">No tasks match these filters.</div>';
    const cols = [['<span class="sr">Project colour</span>', 6], ['Done', 46], ['Task', 0], ['Importance', 104], ['Project', 116], ['Type', 98], ['Est h', 62], ['Logged', 72], ['Deadline', 136], ['Forecast', 150], ['Float', 82], ['<span class="sr">Actions</span>', 98]];
    let body = '';
    if (S.filter.sort === 'project') {
      let cur;
      for (const t of ts) {
        const k = t.projectId && projById(t.projectId) ? t.projectId : '';
        if (k !== cur) {
          cur = k;
          const p = projById(k);
          const folder = p && FOLDERS.includes(p.folder) ? p.folder : 'Other';
          body += `<tr class="grp"><td colspan="${cols.length}">${projTag(k)}${p && folder !== (p.short || p.name) ? `<span class="muted">${esc(folder)}</span>` : ''}</td></tr>`;
        }
        body += rowHtml(t);
      }
    } else body = ts.map(rowHtml).join('');
    return `<div class="sheet-wrap"><table class="sheet"><colgroup>${cols.map(([, w]) => (w ? `<col style="width:${w}px">` : '<col>')).join('')}</colgroup><thead><tr>${cols.map(([h]) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="muted" style="margin-top:8px">Forecast and float use your ${quantile() === 'p80' ? 'safe' : 'typical'} estimate multiplier (×${r2(E.multiplier(S.calib, 'other', quantile()))} overall) and your weekly hours. Float is the work-hours to spare before the deadline.</p>`;
  }
  function depsText(t) {
    const ds = (t.dependsOn || []).map((id) => S.tx[id]).filter(Boolean);
    if (!ds.length) return '';
    return '<span>Waits on ' + ds.map((d) => esc(d.title) + (d.status === 'done' ? ' (done)' : '')).join(', ') + '</span>';
  }
  function fcText(t, f) {
    if (t.status === 'done') return '<span class="muted">Done' + (t.doneAt ? ' ' + esc(dayName(t.doneAt)) : '') + '</span>';
    if (t.status === 'dropped') return '<span class="muted">Dropped</span>';
    if (!isMine(t)) return '<span class="muted">' + esc(t.owner) + (t.externalDue ? ', due ' + esc(dayName(t.externalDue)) : '') + '</span>';
    if (!f || !f.start) return '<span class="faint">Not scheduled</span>';
    if (!f.finish || f.finish === f.start) return esc(dayName(f.start));
    const sameMonth = f.start.slice(0, 7) === f.finish.slice(0, 7);
    return esc(dayName(f.start, sameMonth ? { weekday: 'short', day: 'numeric' } : undefined)) + ' → ' + esc(dayName(f.finish));
  }
  function floatPill(f) {
    if (!f || f.slackH == null) return '<span class="faint">–</span>';
    if (f.late) return `<span class="pill crit">−${esc(fmtH(-f.slackH))}</span>`;
    if (f.slackH < 2) return `<span class="pill warn">${esc(fmtH(f.slackH))}</span>`;
    return `<span class="pill good">${esc(fmtH(f.slackH))}</span>`;
  }
  function rowHtml(t) {
    const f = S.fc && S.fc.tasks[t.id];
    const p = projById(t.projectId);
    const done = t.status === 'done';
    const est = num(t.estimateH);
    const logged = S.tx[t.id] ? S.tx[t.id].actualH : 0;
    const badges = [];
    if (isOpen(t)) badges.push(quadPill(t.id));
    if (t.status === 'doing') badges.push('<span class="pill plain">In progress</span>');
    if (t.status === 'dropped') badges.push('<span class="pill plain">Dropped</span>');
    if (isOpen(t) && isMine(t) && est == null) badges.push('<span class="pill warn">Needs estimate</span>');
    if (f && f.late) badges.push('<span class="pill crit">Forecast late</span>');
    if (S.critSet.has(t.id) && isOpen(t)) badges.push('<span class="pill plain">Critical path</span>');
    if (!isMine(t)) badges.push(`<span class="pill plain">${esc(t.owner)}'s task</span>`);
    if (t.createdBy === 'claude') badges.push('<span class="pill plain">Added by Claude</span>');
    if (t.estimateBy === 'claude' && est != null && isOpen(t)) badges.push("<span class=\"pill plain\">Claude's estimate</span>");
    if (t.source) badges.push(`<span class="pill plain">From ${esc(t.source)}</span>`);
    const ratio = done && est && logged ? `<div class="faint">${r2(logged / est)}× est</div>` : '';
    const deps = depsText(t);
    return `<tr data-id="${esc(t.id)}" class="${done ? 'is-done' : ''}">
      <td class="stripe"><i style="background:${pc(p)}"></i></td>
      <td><input type="checkbox" class="c-done" ${done ? 'checked' : ''} aria-label="Finished: ${esc(t.title)}"></td>
      <td><textarea class="cell c-title" rows="1" aria-label="Task title">${esc(t.title)}</textarea>${badges.length || deps ? `<div class="meta">${badges.join('')}${deps}</div>` : ''}</td>
      <td><select class="cell c-imp" aria-label="Importance">${impOptions(t.importance)}</select></td>
      <td><select class="cell c-proj" aria-label="Project">${projectOptions(t.projectId, true, true)}</select></td>
      <td><select class="cell c-cat" aria-label="Type of work">${categoryOptions(t.category)}</select></td>
      <td class="r"><input class="cell c-est" type="number" min="0" step="0.25" value="${est == null ? '' : est}" aria-label="Estimate in hours"></td>
      <td class="r num">${logged ? esc(fmtH(logged)) : '<span class="faint">–</span>'}${ratio}</td>
      <td><input class="cell c-due" type="date" value="${esc(t.deadline || '')}" aria-label="Deadline"></td>
      <td class="fc">${fcText(t, f)}</td>
      <td class="r">${isOpen(t) && isMine(t) ? floatPill(f) : ''}</td>
      <td><div class="row-actions">${isOpen(t) && isMine(t) ? `<button type="button" class="btn small ghost" data-act="timer" data-id="${esc(t.id)}">Start</button>` : ''}<button type="button" class="btn small ghost" data-act="edit" data-id="${esc(t.id)}">Edit</button></div></td>
    </tr>`;
  }
  function refreshSheet() {
    const host = $('#sheetHost');
    if (host) { S.tips = []; host.innerHTML = sheetHtml(); fitTitles(); }
  }
  // title cells are one-row textareas that grow to fit long titles
  function fitTitle(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 2 + 'px';
  }
  function fitTitles() { $$('#sheetHost textarea.c-title').forEach(fitTitle); }

  // ----- Timeline -----
  function projHealth(pid) {
    const ts = Object.values(S.fc.tasks).filter((t) => t.projectId === pid && t.mine);
    if (!ts.length) return { k: '', label: 'Nothing open' };
    const late = ts.filter((t) => t.late).length;
    if (late) return { k: 'crit', label: late + ' late' };
    const dl = ts.filter((t) => t.slackH != null);
    if (!dl.length) return { k: '', label: 'No deadlines' };
    if (dl.some((t) => t.slackH < 2)) return { k: 'warn', label: 'Tight' };
    return { k: 'good', label: 'On track' };
  }
  function viewTimeline() {
    if (!S.fc) return '<div class="empty">The schedule is not available.</div>';
    const q = quantile();
    let h = `<div class="tl-controls">
      <div class="inline">
        <div class="seg" role="group" aria-label="Range">${[4, 8, 16].map((w) => `<button type="button" data-act="tlweeks" data-w="${w}" aria-pressed="${S.tl.weeks === w}">${w} weeks</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Estimates">
          <button type="button" data-act="tlq" data-q="p50" aria-pressed="${q === 'p50'}">Typical</button>
          <button type="button" data-act="tlq" data-q="p80" aria-pressed="${q === 'p80'}">Safe</button>
        </div>
      </div>
      <span class="muted">${q === 'p80' ? 'Safe: 4 in 5 tasks finish inside these estimates.' : 'Typical: half your tasks run over these estimates.'}</span>
    </div>`;
    const c = S.fc.crunch.firstShortfall;
    if (c) h += `<div class="callout"><strong>Not enough hours by ${esc(dayName(c.by, { weekday: 'long', day: 'numeric', month: 'long' }))}.</strong><span>Work due by then: ${esc(fmtH(c.needH))}. Hours you have: ${esc(fmtH(c.haveH))}. Short by ${esc(fmtH(c.shortH))}. Add hours in Setup, cut scope, or move a deadline.</span></div>`;
    else if (S.fc.crunch.rows.length) h += `<div class="callout ok"><strong>Every deadline fits your hours.</strong><span>Tightest point: ${esc(tightest())}.</span></div>`;
    h += `<section class="panel"><div class="panel-h"><h3>Projects</h3></div><div class="health-wrap"><table class="health"><thead><tr><th>Project</th><th>Status</th><th>Open</th><th>Work left</th><th>Forecast finish</th><th>Next deadline</th><th>Critical path</th></tr></thead><tbody>`;
    const projs = activeProjects();
    for (const p of projs) {
      const po = S.fc.projects[p.id];
      if (!po) continue;
      const st = projHealth(p.id);
      const next = nextDeadline(p);
      const cp = po.criticalPath;
      const cpTxt = cp && cp.taskIds.length > 1 ? `${cp.taskIds.length} tasks, ${esc(fmtH(cp.hours))}<div class="faint">${cp.taskIds.map((id) => esc((S.tx[id] || {}).title || id)).join(' → ')}</div>` : '<span class="faint">No chained tasks</span>';
      h += `<tr><td>${projTag(p.id)}</td><td>${st.k ? `<span class="pill ${st.k}">${esc(st.label)}</span>` : `<span class="muted">${esc(st.label)}</span>`}</td>
        <td class="num">${po.openTasks}</td><td class="num">${esc(fmtH(po.remainingH))}</td>
        <td>${po.forecastFinish ? esc(dayName(po.forecastFinish)) : po.openTasks ? '<span class="faint">Beyond 8 months</span>' : '–'}</td>
        <td>${next ? esc(dayName(next.date)) + ' <span class="muted">' + esc(next.label) + '</span>' : '<span class="faint">–</span>'}</td>
        <td>${cpTxt}</td></tr>`;
    }
    h += '</tbody></table></div></section>';
    h += `<section class="panel"><div class="panel-h"><h3>Timeline</h3><span class="legend"><span><svg width="22" height="10" aria-hidden="true"><rect width="22" height="10" rx="3" fill="var(--s1)"/></svg>Critical path or due soon</span><span><svg width="22" height="10" aria-hidden="true"><rect width="22" height="10" rx="3" fill="var(--s1)" opacity=".45"/></svg>Has float</span><span><svg width="10" height="10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" transform="rotate(45 5 5)" fill="var(--ink)"/></svg>Deadline</span><span><svg width="10" height="10" aria-hidden="true"><path d="M5 0 L10 10 L0 10 Z" fill="var(--ink)"/></svg>Milestone</span></span></div>
      <div class="gantt-wrap">${ganttSvg(S.tl.weeks)}</div></section>`;
    return h;
  }
  function tightest() {
    const rows = S.fc.crunch.rows;
    if (!rows.length) return '';
    let best = rows[0];
    for (const r of rows) if (r.haveH - r.needH < best.haveH - best.needH) best = r;
    return dayName(best.by) + ', ' + fmtH(best.needH) + ' needed of ' + fmtH(best.haveH);
  }
  function nextDeadline(p) {
    const c = [];
    for (const t of S.tasks) if (t.projectId === p.id && isOpen(t) && t.deadline && t.deadline >= S.today) c.push({ date: t.deadline, label: t.title });
    for (const m of p.milestones || []) if (m.date >= S.today) c.push({ date: m.date, label: m.label });
    if (p.deadline && p.deadline >= S.today) c.push({ date: p.deadline, label: 'Project deadline' });
    c.sort((a, b) => a.date.localeCompare(b.date));
    return c[0] || null;
  }
  function ganttSvg(weeks) {
    const today = S.today;
    const days = weeks * 7;
    const end = E.addDays(today, days - 1);
    const avail = Math.max(320, ($('#view').clientWidth || 1000) - 34);
    const labelW = avail < 640 ? 150 : 240;
    const dayW = Math.max(weeks > 8 ? 8 : 13, (avail - labelW - 12) / days);
    const W = Math.round(labelW + days * dayW + 12);
    const rows = [];
    for (const p of activeProjects()) {
      const ts = S.tasks.filter((t) => t.projectId === p.id && isOpen(t)).map((t) => ({ t, f: S.fc.tasks[t.id] })).filter((x) => x.f)
        .sort((a, b) => (a.f.start || (isMine(a.t) ? '9999' : a.t.externalDue || '9999')).localeCompare(b.f.start || (isMine(b.t) ? '9999' : b.t.externalDue || '9999')));
      const ms = (p.milestones || []).filter((m) => m.date >= today && m.date <= end);
      if (!ts.length && !ms.length) continue;
      rows.push({ kind: 'p', p, ms });
      for (const x of ts) rows.push({ kind: 't', p, t: x.t, f: x.f });
    }
    if (!rows.length) return '<div class="empty" style="margin:12px">Nothing to draw yet. Add tasks with estimates and the timeline fills in.</div>';
    const headH = 38, rowH = 26;
    const H = headH + rows.length * rowH + 10;
    const x = (d) => labelW + E.daysBetween(today, d) * dayW;
    const clipTxt = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const maxChars = Math.floor((labelW - 26) / 6.4);
    let g = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Forecast timeline for the next ${weeks} weeks">`;
    for (let i = 0; i < days; i++) {
      const d = E.addDays(today, i);
      const wd = E.weekday(d);
      if (wd >= 5) g += `<rect class="g-wkend" x="${x(d)}" y="${headH}" width="${dayW}" height="${H - headH}"/>`;
      if (wd === 0) {
        g += `<line class="g-grid" x1="${x(d)}" x2="${x(d)}" y1="${headH - 6}" y2="${H}"/>`;
        g += `<text class="g-axis" x="${x(d) + 3}" y="${headH - 9}">${esc(dayName(d, { day: 'numeric', month: 'short' }))}</text>`;
      }
    }
    g += `<line class="g-grid" x1="0" x2="${W}" y1="${headH}" y2="${headH}"/>`;
    rows.forEach((r, i) => {
      const y = headH + i * rowH;
      if (r.kind === 'p') {
        if (i) g += `<line class="g-grid" x1="0" x2="${W}" y1="${y}" y2="${y}"/>`;
        g += `<rect x="8" y="${y + 9}" width="10" height="10" rx="2" fill="${pc(r.p)}"/>`;
        g += `<text class="g-proj" x="24" y="${y + 18}">${esc(clipTxt(r.p.short || r.p.name, maxChars))}</text>`;
        for (const m of r.ms) {
          const mx = x(m.date) + dayW / 2;
          const k = tip(m.label, [dayName(m.date, { weekday: 'long', day: 'numeric', month: 'long' }), r.p.name + ' milestone']);
          g += `<path class="g-ms" d="M${mx} ${y + 6} L${mx + 6} ${y + 18} L${mx - 6} ${y + 18} Z" data-tip="${k}" tabindex="0"/>`;
          g += `<text class="g-ms-l" x="${mx + 9}" y="${y + 17}">${esc(clipTxt(m.label, 28))}</text>`;
        }
        return;
      }
      const t = r.t, f = r.f;
      g += `<text class="g-task${isMine(t) ? '' : ' muted'}" x="24" y="${y + 17}">${esc(clipTxt(t.title, maxChars))}</text>`;
      const lines = [];
      if (isMine(t)) {
        lines.push((f.start ? dayName(f.start) : '?') + ' → ' + (f.finish ? dayName(f.finish) : 'after the horizon'));
        lines.push(fmtH(f.remainingH) + ' left · estimate ×' + f.multiplier);
        if (f.deadline) lines.push('Deadline ' + dayName(f.deadline) + (f.softDeadline ? ' (weekly pace)' : ''));
        if (f.slackH != null) lines.push(f.late ? 'Late by ' + fmtH(-f.slackH) : 'Float ' + fmtH(f.slackH));
      } else {
        lines.push(t.owner + "'s task" + (t.externalDue ? ', due ' + dayName(t.externalDue) : ''));
      }
      const k = tip(t.title, [r.p.name].concat(lines));
      if (isMine(t) && f.start) {
        const fin = f.finish || end;
        const x0 = Math.max(labelW, x(f.start)), x1 = Math.min(W - 12, x(fin) + dayW);
        if (f.start <= end && x1 > x0) {
          const strong = S.critSet.has(t.id) || f.late || (f.slackH != null && f.slackH < 4);
          g += `<rect class="g-bar" x="${x0 + 1}" y="${y + 7}" width="${Math.max(4, x1 - x0 - 2)}" height="12" rx="3" fill="${pc(r.p)}"${strong ? '' : ' opacity=".45"'} data-tip="${k}" tabindex="0"/>`;
          if (f.late) g += `<text x="${Math.min(x1 + 4, W - 40)}" y="${y + 17}" font-size="11" font-weight="600" fill="var(--crit-ink)">late</text>`;
        } else if (f.start > end) {
          g += `<text class="g-ms-l" x="${W - 14}" y="${y + 17}" text-anchor="end" data-tip="${k}" tabindex="0">${esc('from ' + dayName(f.start) + ' →')}</text>`;
        }
      } else if (!isMine(t) && t.externalDue && t.externalDue <= end && t.externalDue >= today) {
        const mx = x(t.externalDue) + dayW / 2;
        g += `<rect x="${mx - 5}" y="${y + 8}" width="10" height="10" transform="rotate(45 ${mx} ${y + 13})" fill="none" stroke="${pc(r.p)}" stroke-width="2" data-tip="${k}" tabindex="0"/>`;
      }
      if (f.deadline && f.deadline >= today && f.deadline <= end && !f.softDeadline) {
        const dx = x(f.deadline) + dayW;
        g += `<rect class="g-dl${f.late ? ' late' : ''}" x="${dx - 4}" y="${y + 9}" width="8" height="8" transform="rotate(45 ${dx} ${y + 13})"/>`;
      }
    });
    g += `<line class="g-today" x1="${labelW}" x2="${labelW}" y1="${headH - 6}" y2="${H}"/>`;
    g += `<text x="${labelW + 3}" y="11" font-size="11" fill="var(--accent)" font-weight="600">Today</text>`;
    return g + '</svg>';
  }

  // ----- Insights -----
  function viewInsights() {
    const cal = S.calib;
    const g = cal.global;
    const fi = S.factorInfo;
    const n = cal.sampleSize;
    let h = `<div class="tiles">
      <div class="tile"><span class="k">Typical overrun</span><span class="v">×${r2(g.p50)}</span><span class="d">${n ? 'Half your tasks take longer than estimate × this.' : 'Starting assumption until you finish tasks.'}</span></div>
      <div class="tile"><span class="k">Safe multiplier</span><span class="v">×${r2(g.p80)}</span><span class="d">4 in 5 tasks fit inside estimate × this.</span></div>
      <div class="tile"><span class="k">Finished tasks measured</span><span class="v">${n}</span><span class="d">${n < 5 ? 'Needs about 5 to start learning, 15–20 to settle.' : g.rawMedian ? 'Your raw median ratio is ×' + r2(g.rawMedian) + '.' : ''}</span></div>
      <div class="tile"><span class="k">Hours that happen</span><span class="v">${fi ? Math.round(fi.factor * 100) + '%' : '–'}</span><span class="d">${fi ? 'of your planned weekly hours, over ' + fi.days + ' days. The schedule uses ' + Math.round(Math.min(1.3, Math.max(0.5, fi.factor)) * 100) + '%.' : 'Shows after two weeks of logging.'}</span></div>
    </div>`;
    const cats = Object.values(cal.byCat).sort((a, b) => b.n - a.n);
    h += `<div class="two"><section class="panel"><div class="panel-h"><h3>By type of work</h3></div>`;
    if (!cats.length) h += '<div class="empty">Once you finish tasks that had an estimate and logged time, each type of work (CAD, writing, coding…) gets its own multiplier here.</div>';
    else h += `<div class="tbl-wrap"><table class="plain"><thead><tr><th>Type</th><th>Tasks</th><th>Your ratio</th><th>Typical ×</th><th>Safe ×</th></tr></thead><tbody>${cats.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.n}</td><td class="num">×${r2(c.rawMedian)}</td><td class="num">×${r2(c.p50)}</td><td class="num">×${r2(c.p80)}</td></tr>`).join('')}</tbody></table></div><p class="muted" style="margin-top:8px">Small samples lean toward your overall figure until they have more data.</p>`;
    h += `</section><section class="panel chart">${scatterSvg()}</section></div>`;
    h += `<section class="panel chart">${weeklySvg()}</section>`;
    const recent = S.logs.slice(0, 60);
    h += `<section class="panel"><div class="panel-h"><h3>All logs</h3><span class="muted">${S.logs.length} entries · newest first</span></div>`;
    h += recent.length ? '<ul class="items">' + recent.map((l) => logRow(l, true)).join('') + '</ul>' : '<div class="empty">No logs yet.</div>';
    return h + '</section>';
  }
  function scatterSvg() {
    const pts = [];
    for (const t of S.tasks) {
      const est = ownEstimate(t);
      const act = S.tx[t.id] && S.tx[t.id].actualH;
      if (t.status === 'done' && est > 0 && act > 0) pts.push({ t, est, act });
    }
    let h = '<div class="panel-h"><h3>Estimate vs actual</h3><span class="muted">Finished tasks. Above the line ran over.</span></div>';
    if (!pts.length) return h + '<div class="empty">Each finished task with an estimate and logged time becomes a dot here.</div>';
    const W = 460, H = 300, L = 44, R = 12, T = 12, B = 36;
    const lo = 0.25, hi = 32;
    const sx = (v) => L + (Math.log2(Math.min(hi, Math.max(lo, v)) / lo) / Math.log2(hi / lo)) * (W - L - R);
    const sy = (v) => H - B - (Math.log2(Math.min(hi, Math.max(lo, v)) / lo) / Math.log2(hi / lo)) * (H - T - B);
    let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated against actual hours for finished tasks">`;
    for (const v of [0.25, 0.5, 1, 2, 4, 8, 16, 32]) {
      g += `<line class="c-grid" x1="${sx(v)}" x2="${sx(v)}" y1="${T}" y2="${H - B}"/><line class="c-grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/>`;
      g += `<text class="c-axis" x="${sx(v)}" y="${H - B + 14}" text-anchor="middle">${v}</text><text class="c-axis" x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`;
    }
    g += `<line class="c-ref" x1="${sx(lo)}" y1="${sy(lo)}" x2="${sx(hi)}" y2="${sy(hi)}"/>`;
    g += `<text class="c-axis" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Estimated hours</text>`;
    g += `<text class="c-axis" transform="translate(11 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">Actual hours</text>`;
    for (const p of pts) {
      const k = tip(p.t.title, [projName(p.t.projectId), 'Estimate ' + fmtH(p.est) + ', actual ' + fmtH(p.act) + ' (×' + r2(p.act / p.est) + ')']);
      g += `<circle cx="${sx(p.est)}" cy="${sy(p.act)}" r="12" fill="transparent" data-tip="${k}" tabindex="0"/><circle class="c-pt" cx="${sx(p.est)}" cy="${sy(p.act)}" r="5" fill="${pc(projById(p.t.projectId))}" pointer-events="none"/>`;
    }
    const used = Array.from(new Set(pts.map((p) => p.t.projectId)));
    const legend = '<div class="legend" style="margin-top:6px">' + used.map((id) => `<span><i class="swatch" style="background:${pc(projById(id))};border-radius:50%"></i>${esc(projName(id))}</span>`).join('') + '</div>';
    return h + g + '</svg>' + legend;
  }
  function weeklySvg() {
    const first = S.logs.reduce((a, l) => (l.date && l.date < a ? l.date : a), S.today);
    const thisMon = E.addDays(S.today, -E.weekday(S.today));
    const firstMon = E.addDays(first, -E.weekday(first));
    const weeks = Math.min(12, Math.max(4, Math.round(E.daysBetween(firstMon, thisMon) / 7) + 1));
    const mon0 = E.addDays(thisMon, -(weeks - 1) * 7);
    const projs = activeProjects();
    const ids = projs.map((p) => p.id).concat(['_none']);
    const data = [];
    for (let w = 0; w < weeks; w++) {
      const a = E.addDays(mon0, w * 7), b = E.addDays(a, 6);
      const by = {};
      for (const l of S.logs) if (l.date >= a && l.date <= b) { const k = projById(l.projectId) ? l.projectId : '_none'; by[k] = (by[k] || 0) + (l.minutes || 0) / 60; }
      let plan = 0;
      if (b >= firstMon) for (let i = 0; i < 7; i++) plan += dayTarget(E.addDays(a, i));
      data.push({ a, by, total: Object.values(by).reduce((x, y) => x + y, 0), plan });
    }
    let h = '<div class="panel-h"><h3>Hours logged per week</h3><span class="muted">Line marks your planned weekly hours.</span></div>';
    if (!S.logs.length) return h + '<div class="empty">Logged hours stack up here week by week, by project.</div>';
    const W = 760, H = 250, L = 40, R = 10, T = 14, B = 30;
    const maxV = Math.max(4, ...data.map((d) => Math.max(d.total, d.plan))) * 1.1;
    const step = maxV > 40 ? 10 : maxV > 16 ? 5 : 2;
    const sy = (v) => H - B - (v / maxV) * (H - T - B);
    const band = (W - L - R) / weeks;
    const bw = Math.min(24, band * 0.5);
    let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hours logged per week by project">`;
    for (let v = 0; v <= maxV; v += step) g += `<line class="c-grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text class="c-axis" x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`;
    data.forEach((d, i) => {
      const cx = L + band * i + band / 2;
      let acc = 0;
      for (const id of ids) {
        const v = d.by[id];
        if (!v) continue;
        const y0 = sy(acc), y1 = sy(acc + v);
        const p = projById(id);
        const k = tip(fmtH(v), [(p ? p.name : 'No project') + ', week of ' + dayName(d.a)]);
        g += `<rect x="${cx - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1 - 2)}" fill="${p ? pc(p) : 'var(--faint)'}" data-tip="${k}" tabindex="0"/>`;
        acc += v;
      }
      if (d.plan) g += `<line x1="${cx - band * 0.38}" x2="${cx + band * 0.38}" y1="${sy(d.plan)}" y2="${sy(d.plan)}" stroke="var(--ink)" stroke-width="2"/>`;
      g += `<text class="c-axis" x="${cx}" y="${H - B + 16}" text-anchor="middle">${esc(dayName(d.a, { day: 'numeric', month: 'short' }))}</text>`;
      if (d.total) g += `<text class="c-axis" x="${cx}" y="${sy(acc) - 5}" text-anchor="middle">${r1(d.total)}</text>`;
    });
    g += '</svg>';
    const used = ids.filter((id) => data.some((d) => d.by[id]));
    const legend = '<div class="legend" style="margin-top:8px">' + used.map((id) => { const p = projById(id); return `<span><i class="swatch" style="background:${p ? pc(p) : 'var(--faint)'}"></i>${esc(p ? p.short || p.name : 'No project')}</span>`; }).join('') + '</div>';
    return h + g + legend;
  }

  // ----- Setup -----
  // a subscribed feed's name is often its URL; show something readable
  function calLabel(id) {
    const c = (S.calendars || []).find((x) => x.id === id);
    const name = c && c.summary;
    if (name && !/^(https?|webcal):|\.ics\b/i.test(name)) return name;
    if (/@import\.calendar\.google\.com$/.test(id)) return 'Subscribed timetable';
    return name || id;
  }
  function viewSetup() {
    const s = S.settings;
    const fi = S.factorInfo;
    let h = '<div class="setup">';
    if (SA) h += setupSyncPanel();
    // projects
    h += `<section class="panel"><div class="panel-h"><h3>Projects</h3><span class="muted">Names and other names help the log box recognise what you say.</span></div>`;
    h += `<div class="tbl-wrap"><table class="plain proj-table"><thead><tr><th>Project</th><th class="c-folder">Folder</th><th class="c-alias">Other names</th><th>Open</th><th>Work left</th><th class="c-ms">Milestones</th><th></th></tr></thead><tbody>`;
    for (const p of S.projects.slice().sort(byFolder)) {
      const po = S.fc && S.fc.projects[p.id];
      h += `<tr${p.active === false ? ' class="faint"' : ''}><td>${projTag(p.id)}${p.active === false ? ' <span class="pill plain">Archived</span>' : ''}</td>
        <td class="muted c-folder">${esc(FOLDERS.includes(p.folder) ? p.folder : 'Other')}</td>
        <td class="muted c-alias">${esc((p.aliases || []).join(', '))}</td>
        <td class="num">${po ? po.openTasks : '–'}</td><td class="num">${po ? esc(fmtH(po.remainingH)) : '–'}</td>
        <td class="muted c-ms">${(p.milestones || []).length || ''}</td>
        <td><button type="button" class="btn small" data-act="editproj" data-id="${esc(p.id)}">Edit</button></td></tr>`;
    }
    h += `</tbody></table></div>
      <form id="addProj" class="inline" style="margin-top:10px" autocomplete="off">
        <input class="field" id="apName" placeholder="New project name" aria-label="New project name" required style="width:min(320px,100%)">
        <button class="btn" type="submit">Add project</button>
      </form></section>`;
    // hours
    h += `<section class="panel"><div class="panel-h"><h3>Weekly project hours</h3><span class="muted">Hours you can give projects each day, outside lectures and fixed commitments. A starting guess: change it.</span></div>
      <div class="hours">${DAYS.map((d, i) => `<label>${d}<input class="field" type="number" min="0" max="16" step="0.5" data-set="weekHours" data-i="${i}" value="${esc(s.weekHours[i])}"></label>`).join('')}</div>
      <p class="muted" style="margin-top:10px">${s.weekHours.reduce((a, b) => a + (num(b) || 0), 0)} h a week.</p>
      <label class="check" style="margin-top:8px"><input type="checkbox" data-set="useLearnedFactor" ${s.useLearnedFactor ? 'checked' : ''}> Scale these by how many planned hours actually happen ${fi ? `(currently ${Math.round(fi.factor * 100)}%, from ${fi.days} days)` : '(after two weeks of logging)'}</label>
    </section>`;
    // day
    h += `<section class="panel"><div class="panel-h"><h3>Planning a day</h3></div>
      <div class="inline">
        <label class="f"><span>Day starts</span><input class="field" type="time" data-set="dayStart" value="${esc(s.dayStart)}"></label>
        <label class="f"><span>Day ends</span><input class="field" type="time" data-set="dayEnd" value="${esc(s.dayEnd)}"></label>
        <label class="f"><span>Gap around events (min)</span><input class="field" type="number" min="0" max="60" step="5" data-set="bufferMin" value="${esc(s.bufferMin)}"></label>
        <label class="f"><span>Shortest useful slot (min)</span><input class="field" type="number" min="10" max="120" step="5" data-set="minBlockMin" value="${esc(s.minBlockMin)}"></label>
      </div></section>`;
    // calendars
    h += `<section class="panel"><div class="panel-h"><h3>Calendars</h3>${S.mcp ? `<button type="button" class="btn small" data-act="loadcals" ${S.busy.cals ? 'disabled' : ''}>${S.busy.cals ? 'Loading…' : S.calendars ? 'Reload calendars' : 'Load my calendars'}</button>` : ''}</div>`;
    if (!S.mcp) h += '<p class="muted">' + (SA ? 'Google Calendar needs Google sign-in, which is not set up in this copy of the app.' : 'Calendar access is not available in this view.') + '</p>';
    if (S.calendars) {
      const busy = new Set(s.busyCalendars);
      h += `<p class="muted" style="margin-bottom:8px">Plan around events on:</p><div class="cal-list">${S.calendars.map((c) => `<label class="check"><input type="checkbox" data-act="busycal" value="${esc(c.id)}" ${busy.has(c.id) ? 'checked' : ''}> ${esc(calLabel(c.id))}</label>`).join('')}</div>`;
      h += `<div class="inline" style="margin-top:14px"><label class="f"><span>Put logs on</span><select class="field" data-set="logCalendarId">${opt('', 'Primary calendar', s.logCalendarId)}${S.calendars.filter((c) => !/holiday|import\.calendar|classroom/i.test(c.id)).map((c) => opt(c.id, calLabel(c.id), s.logCalendarId)).join('')}</select></label>`;
    } else {
      h += `<p class="muted wrap-any">Planning reads: ${s.busyCalendars.length ? s.busyCalendars.map((id) => esc(calLabel(id))).join(', ') : 'your primary calendar'}.<br>Logs go to: ${esc(s.logCalendarId ? calLabel(s.logCalendarId) : 'your primary calendar')}.</p><div class="inline" style="margin-top:14px">`;
    }
    h += `<label class="f"><span>Log colour</span><select class="field" data-set="logColorId">${GCOLORS.map(([id, n]) => opt(id, n, s.logColorId)).join('')}</select></label>
      <label class="f"><span>Plan colour</span><select class="field" data-set="planColorId">${GCOLORS.map(([id, n]) => opt(id, n, s.planColorId)).join('')}</select></label></div>
      <div class="inline" style="margin-top:12px">
        <label class="check"><input type="checkbox" data-set="logToCalendar" ${s.logToCalendar ? 'checked' : ''}> Put each log on my calendar</label>
        <label class="check"><input type="checkbox" data-set="planToCalendar" ${s.planToCalendar ? 'checked' : ''}> Put each day's plan on my calendar</label></div>
      <p class="muted" style="margin-top:8px">Logs go on as “free” time so they never block anything. Planned blocks go on in their own colour; re-planning replaces the ones that haven't started, and the planner ignores its own blocks when it reads your calendar.</p></section>`;
    // types & estimates
    h += `<section class="panel"><div class="panel-h"><h3>Types of work and estimates</h3></div>
      <label class="f"><span>Types of work (comma separated)</span><input class="field" data-set="categories" value="${esc(s.categories.join(', '))}"></label>
      <div class="inline" style="margin-top:12px"><span class="muted">Plan with</span>
        <div class="seg" role="group" aria-label="Default estimates"><button type="button" data-act="setq" data-q="p50" aria-pressed="${s.quantile !== 'p80'}">Typical estimates</button><button type="button" data-act="setq" data-q="p80" aria-pressed="${s.quantile === 'p80'}">Safe estimates</button></div></div>
      ${SA ? '' : `<label class="check" style="margin-top:12px"><input type="checkbox" data-set="askClaude" ${s.askClaude ? 'checked' : ''}> Offer “Ask Claude” when the log box can't read a line (quick model, uses a little of your Claude usage)</label>`}
    </section>`;
    if (SA) h += setupAiPanel();
    // export
    h += `<section class="panel"><div class="panel-h"><h3>Your data</h3></div>
      <div class="inline">${S.downloads ? `<button type="button" class="btn primary" data-act="exportall" ${S.busy.export ? 'disabled' : ''}>${S.busy.export ? 'Exporting…' : 'Export everything (JSON)'}</button><button type="button" class="btn" data-act="csv" data-kind="tasks">Download tasks (CSV)</button><button type="button" class="btn" data-act="csv" data-kind="logs">Download logs (CSV)</button>` : '<span class="muted">Downloads are not available in this view.</span>'}${SA ? '<button type="button" class="btn" data-act="import">Import a file</button>' : ''}</div>
      ${SA ? `<p class="muted" style="margin-top:10px">Export everything saves every project, task, log, plan and setting in one file: a backup you can keep anywhere. Import a file reads an export from this app or from the claude.ai Logbook; it adds and updates, and never deletes.</p>`
        : `<p class="muted" style="margin-top:10px">Export everything saves every project, task, log, plan and setting in one file. Keep a recent copy: it's your backup, and it's how your data moves to the stand-alone app.</p>
      <p class="muted" style="margin-top:6px">Tasks, logs and settings live in this page's own database. Claude can read them and add tasks when you ask in chat; those show “Added by Claude”.</p>`}</section>`;
    return h + '</div>';
  }

  // ---------- drawer ----------
  function openDrawer(inner) {
    const root = $('#drawerRoot');
    root.innerHTML = `<div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">${inner}</aside>`;
    S.drawerReturn = document.activeElement;
    const first = $('.drawer input, .drawer select, .drawer textarea', root);
    if (first) first.focus();
  }
  function closeDrawer() {
    $('#drawerRoot').innerHTML = '';
    if (S.drawerReturn && document.body.contains(S.drawerReturn)) S.drawerReturn.focus();
    if (S.pending) render();
  }
  function taskDrawer(id) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) return;
    const deps = new Set(t.dependsOn || []);
    const others = S.tasks.filter((x) => x.id !== t.id && x.status !== 'dropped' && (isOpen(x) || deps.has(x.id)));
    const groups = activeProjects().map((p) => [p, others.filter((x) => x.projectId === p.id)]).filter(([, xs]) => xs.length);
    groups.sort((a, b) => (a[0].id === t.projectId ? -1 : b[0].id === t.projectId ? 1 : 0));
    const est0 = num(t.estimateH0);
    openDrawer(`<header><h2 id="drawerTitle" style="font-size:1.4rem">Edit task</h2>${SA ? `<div class="inline"><button type="button" class="btn ghost" data-act="analyze" data-id="${esc(t.id)}">Analyze</button><button type="button" class="btn ghost" data-act="close">Close</button></div>` : '<button type="button" class="btn ghost" data-act="close">Close</button>'}</header>
      <div class="body"><form id="taskForm" class="form-grid" data-id="${esc(t.id)}" autocomplete="off">
        <label class="f full"><span>Task</span><input class="field" name="title" value="${esc(t.title)}" required></label>
        <label class="f"><span>Project</span><select class="field" name="projectId">${projectOptions(t.projectId, true)}</select></label>
        <label class="f"><span>Type of work</span><select class="field" name="category">${categoryOptions(t.category)}</select></label>
        <label class="f"><span>Estimate (h)</span><input class="field" name="estimateH" type="number" min="0" step="0.25" value="${num(t.estimateH) == null ? '' : num(t.estimateH)}">${est0 != null && est0 !== num(t.estimateH) ? `<small>First estimate ${fmtH(est0)} is kept for calibration.</small>` : ''}</label>
        <label class="f"><span>Status</span><select class="field" name="status">${opt('todo', 'To do', t.status || 'todo')}${opt('doing', 'In progress', t.status)}${opt('done', 'Done', t.status)}${opt('dropped', 'Dropped', t.status)}</select></label>
        <label class="f"><span>Importance</span><select class="field" name="importance">${impOptions(t.importance)}</select><small>Low importance drops it to Fit in or Later.</small></label>
        <label class="f"><span>Deadline</span><input class="field" name="deadline" type="date" value="${esc(t.deadline || '')}"></label>
        <label class="f"><span>Not before</span><input class="field" name="notBefore" type="date" value="${esc(t.notBefore || '')}"><small>Can't start until then.</small></label>
        <label class="f"><span>Who does it</span><input class="field" name="owner" placeholder="me" value="${esc(isMine(t) ? '' : t.owner)}"><small>A teammate's name if it's their work.</small></label>
        <label class="f"><span>Their due date</span><input class="field" name="externalDue" type="date" value="${esc(t.externalDue || '')}"></label>
        <div class="f full"><span>Waits on</span>
          <input class="field" id="depFilter" type="search" placeholder="Filter tasks" aria-label="Filter tasks to wait on">
          <div class="deplist" id="depList">${groups.length ? groups.map(([p, xs]) => `<div class="grp">${esc(p.name)}</div>` + xs.map((x) => `<label class="check" data-name="${esc((x.title || '').toLowerCase())}"><input type="checkbox" name="dep" value="${esc(x.id)}" ${deps.has(x.id) ? 'checked' : ''}> ${esc(x.title)}${x.status === 'done' ? ' (done)' : ''}</label>`).join('')).join('') : '<span class="muted">No other open tasks.</span>'}</div>
        </div>
        <label class="f full"><span>Notes</span><textarea class="field" name="notes" rows="3">${esc(t.notes || '')}</textarea></label>
        <p class="muted f full" id="taskFormMsg"></p>
      </form></div>
      <footer><button type="button" class="btn danger" data-act="deltask" data-id="${esc(t.id)}">Delete task</button>
        <div class="inline"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn primary" data-act="savetask" data-id="${esc(t.id)}">Save</button></div></footer>`);
  }
  function projDrawer(id) {
    const p = S.projects.find((x) => x.id === id);
    if (!p) return;
    const slot = Number(p.color) || 0;
    const fsel = FOLDERS.includes(p.folder) ? p.folder : '';
    openDrawer(`<header><h2 id="drawerTitle" style="font-size:1.4rem">Edit project</h2><button type="button" class="btn ghost" data-act="close">Close</button></header>
      <div class="body"><form id="projForm" class="form-grid" data-id="${esc(p.id)}" autocomplete="off">
        <label class="f full"><span>Name</span><input class="field" name="name" value="${esc(p.name)}" required></label>
        <label class="f"><span>Short name</span><input class="field" name="short" value="${esc(p.short || '')}" placeholder="${esc(p.name)}"></label>
        <label class="f"><span>Colour</span><select class="field" name="color">${SLOT_NAMES.map((n, i) => opt(String(i + 1), n, String(slot || ''))).join('')}</select></label>
        <label class="f"><span>Folder</span><select class="field" name="folder">${FOLDERS.map((f) => opt(f, f, fsel)).join('')}${opt('', 'Other', fsel)}</select></label>
        <label class="f full"><span>Other names</span><input class="field" name="aliases" value="${esc((p.aliases || []).join(', '))}"><small>Words you might say for this project, comma separated. Include how dictation mishears it.</small></label>
        <label class="f"><span>Priority</span><select class="field" name="priority">${opt('2', 'High', String(p.priority ?? 1))}${opt('1', 'Normal', String(p.priority ?? 1))}${opt('0', 'Low', String(p.priority ?? 1))}</select><small>Breaks ties between equal deadlines.</small></label>
        <label class="f"><span>Tasks per week</span><input class="field" name="pacePerWeek" type="number" min="0" step="0.5" value="${p.pacePerWeek ?? ''}"><small>For rolling work without dates.</small></label>
        <label class="f"><span>Project deadline</span><input class="field" name="deadline" type="date" value="${esc(p.deadline || '')}"><small>Every task must finish by then.</small></label>
        <label class="f"><span>Default type</span><select class="field" name="defaultCategory">${categoryOptions(p.defaultCategory)}</select></label>
        <label class="f full"><span>Milestones</span><textarea class="field" name="milestones" rows="5" placeholder="2026-11-20 Concept Paper due">${esc((p.milestones || []).map((m) => m.date + ' ' + m.label).join('\n'))}</textarea><small>One per line: date then label. Shown on the timeline.</small></label>
        <label class="check f full"><input type="checkbox" name="active" ${p.active === false ? '' : 'checked'}> Active (archived projects leave the schedule)</label>
        <p class="muted f full" id="projFormMsg"></p>
      </form></div>
      <footer><span></span><div class="inline"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn primary" data-act="saveproj" data-id="${esc(p.id)}">Save</button></div></footer>`);
  }

  // ---------- log box ----------
  function parseNow() {
    const text = $('#logText').value;
    if (!text.trim()) { S.draft.parsed = null; return; }
    const archived = archivedSet();
    S.draft.parsed = P.parseLog(text, {
      tasks: S.tasks.filter((t) => !archived.has(t.projectId)),
      projects: activeProjects().map((p) => ({ id: p.id, name: p.name, aliases: (p.aliases || []).concat(p.short ? [p.short] : []) })),
      now: new Date(),
    });
  }
  function resolved() {
    const r = S.draft.parsed || {};
    const o = S.draft.over;
    const tm = S.draft.timer;
    const minutes = o.minutes !== undefined ? o.minutes : r.minutes != null ? r.minutes : tm ? tm.minutes : null;
    let taskSel = o.taskSel !== undefined ? o.taskSel : tm && tm.taskId ? 't:' + tm.taskId : r.taskId ? 't:' + r.taskId : (r.title || (tm && tm.title)) ? 'new' : 'none';
    const task = taskSel.startsWith('t:') ? S.tx[taskSel.slice(2)] : null;
    if (taskSel.startsWith('t:') && !task) taskSel = 'new';
    const done = o.done !== undefined ? o.done : r.done === true;
    const date = o.date || (tm ? tm.date : E.addDays(localDate(), r.dayOffset || 0));
    const start = o.start !== undefined ? o.start || null : r.start || (tm ? tm.start : null);
    const projectId = task ? task.projectId : o.projectId !== undefined ? o.projectId : r.projectId || S.lastProj || '';
    const newTitle = o.newTitle !== undefined ? o.newTitle : r.title || (tm && tm.title) || '';
    return { minutes, taskSel, task, done, date, start, projectId, newTitle };
  }
  function taskOptions(sel) {
    const r = S.draft.parsed;
    const archived = archivedSet();
    const cands = ((r && r.candidates) || []).map((c) => c.id).filter((id) => S.tx[id] && S.tx[id].status !== 'dropped');
    let h = '';
    if (cands.length) h += '<optgroup label="Best matches">' + cands.map((id) => opt('t:' + id, S.tx[id].title + (S.tx[id].status === 'done' ? ' (done)' : ''), sel)).join('') + '</optgroup>';
    h += opt('new', 'New task…', sel) + opt('none', 'No task, just project time', sel);
    const listed = new Set(cands);
    for (const p of activeProjects()) {
      const ts = S.tasks.filter((t) => t.projectId === p.id && isOpen(t) && !listed.has(t.id)).sort(byOrder);
      ts.forEach((t) => listed.add(t.id));
      if (ts.length) h += `<optgroup label="${esc(p.name)}">` + ts.map((t) => opt('t:' + t.id, t.title, sel)).join('') + '</optgroup>';
    }
    if (sel && sel.startsWith('t:') && !listed.has(sel.slice(2)) && S.tx[sel.slice(2)]) h = opt(sel, S.tx[sel.slice(2)].title, sel) + h;
    void archived;
    return h;
  }
  function endLabel(v) {
    if (!v.start || !v.minutes) return '';
    return D.hhmm((D.toMin(v.start) + Math.round(v.minutes)) % 1440);
  }
  function renderPreview(force) {
    const host = $('#preview');
    const a = document.activeElement;
    if (!force && a && host.contains(a) && a.tagName !== 'BUTTON') return;
    const text = $('#logText').value.trim();
    if (!text) {
      host.innerHTML = '<p class="hint-line">Type or dictate what you did and how long it took. Say “done” or “finished” to tick the task off. Press Enter to log it.</p>';
      return;
    }
    const v = resolved();
    const r = S.draft.parsed || { issues: [] };
    const issues = [];
    if (!v.minutes) issues.push('Add how long it took, like “45 min” or “2 h”.');
    if (v.taskSel === 'new' && !String(v.newTitle || '').trim()) issues.push('Name the new task.');
    if (r.issues && r.issues.includes('Two tasks match equally; pick one.') && S.draft.over.taskSel === undefined) issues.push('Two tasks match equally. Pick the right one.');
    const unsure = !r.confident || issues.length;
    const canAsk = S.sample && S.settings.askClaude && unsure;
    host.innerHTML = `<div class="pv">
        <label class="pv-f"><span>Time</span><input class="field" id="pvMin" type="number" min="1" max="960" step="5" value="${v.minutes == null ? '' : Math.round(v.minutes)}"><span class="pv-dur" id="pvDur">${v.minutes ? esc(fmtMin(v.minutes)) : 'min'}</span></label>
        <label class="pv-f"><span>Day</span><input class="field" id="pvDate" type="date" value="${esc(v.date)}"></label>
        <label class="pv-f"><span>From</span><input class="field" id="pvStart" type="time" value="${esc(v.start || '')}"><span class="pv-dur" id="pvEnd">${v.start ? 'to ' + esc(endLabel(v)) : 'ending now'}</span></label>
        <label class="pv-f"><span>Task</span><select class="field" id="pvTask">${taskOptions(v.taskSel)}</select></label>
        ${v.taskSel === 'new' ? `<label class="pv-f"><span>Name</span><input class="field pv-new" id="pvNewTitle" value="${esc(v.newTitle || '')}"></label>` : ''}
        ${v.taskSel === 'new' || v.taskSel === 'none' ? `<label class="pv-f"><span>Project</span><select class="field" id="pvProj">${projectOptions(v.projectId, true)}</select></label>` : ''}
        <label class="check pv-f"><input type="checkbox" id="pvDone" ${v.done ? 'checked' : ''}> Finished</label>
      </div>
      ${issues.length || canAsk ? `<div class="pv-issues">${issues.map((i) => `<span>${esc(i)}</span>`).join('')}${canAsk ? `<button type="button" class="btn small" id="askBtn" data-act="ask">Ask Claude to read it</button>` : ''}</div>` : ''}`;
  }
  function timesFor(v) {
    const mins = Math.round(v.minutes);
    let s, e;
    if (v.start) { s = D.toMin(v.start); e = s + mins; }
    else { e = minOfDay(new Date()); s = e - mins; if (s < 0) { s = 0; e = mins; } }
    const endDate = e >= 1440 ? E.addDays(v.date, 1) : v.date;
    return { date: v.date, start: D.hhmm(s), end: D.hhmm(e % 1440), endDate };
  }
  function clearDraft() {
    $('#logText').value = '';
    S.draft = { parsed: null, over: {}, timer: null };
    autoGrow();
    renderPreview(true);
  }
  async function saveLog() {
    if (S.saving) return;
    if (!S.db) { toast(NO_DB, { bad: true }); return; }
    if (!$('#logText').value.trim()) { $('#logText').focus(); return; }
    parseNow();
    const v = resolved();
    if (!v.minutes || v.minutes <= 0) { renderPreview(true); const m = $('#pvMin'); if (m) m.focus(); return; }
    if (v.minutes > 16 * 60) { toast('That is more than 16 hours. Check the time.', { bad: true }); return; }
    if (v.taskSel === 'new' && !String(v.newTitle || '').trim()) { renderPreview(true); const n = $('#pvNewTitle'); if (n) n.focus(); return; }
    S.saving = true;
    $('#saveLog').disabled = true;
    const undo = { logId: null, newTaskId: null, taskPrev: null, calP: null };
    try {
      let taskId = null, projectId = v.projectId || null, title;
      if (v.task) {
        taskId = v.task.id; projectId = v.task.projectId || null; title = v.task.title;
      } else if (v.taskSel === 'new') {
        title = String(v.newTitle).trim().replace(/^./, (c) => c.toUpperCase());
        taskId = uid('t');
        const p = projById(projectId);
        await write('tasks/' + taskId, (ref) => ref.set({
          title, projectId: projectId || null, status: v.done ? 'done' : 'doing', estimateH: null,
          category: (p && p.defaultCategory) || null, dependsOn: [], createdBy: 'harvey', createdAt: new Date().toISOString(),
          order: Date.now(), doneAt: v.done ? v.date : null,
        }));
        undo.newTaskId = taskId;
      } else {
        title = projectId ? 'Time on ' + (projById(projectId) || {}).name : 'Time logged';
      }
      if (projectId) S.lastProj = projectId;
      const tm = timesFor(v);
      const logId = uid('l');
      const log = {
        date: tm.date, start: tm.start, end: tm.end, minutes: Math.round(v.minutes), taskId, projectId, title,
        done: !!v.done, text: $('#logText').value.trim().slice(0, 500), source: S.draft.timer ? 'timer' : 'typed',
        createdAt: new Date().toISOString(),
      };
      await write('logs/' + logId, (ref) => ref.set(log));
      undo.logId = logId;
      if (v.task) {
        const t = v.task;
        if (v.done && t.status !== 'done') {
          undo.taskPrev = { id: t.id, status: t.status || 'todo', doneAt: t.doneAt || null };
          await write('tasks/' + t.id, (ref) => ref.update({ status: 'done', doneAt: tm.date }));
        } else if (!v.done && (!t.status || t.status === 'todo')) {
          undo.taskPrev = { id: t.id, status: t.status || 'todo', doneAt: t.doneAt || null };
          await write('tasks/' + t.id, (ref) => ref.update({ status: 'doing' }));
        }
      }
      clearDraft();
      undo.calP = logToCalendar(logId, Object.assign({ endDate: tm.endDate }, log));
      toast('Logged ' + fmtMin(log.minutes) + ' on ' + title + (v.done ? ', marked finished' : '') + '.', { action: { label: 'Undo', fn: () => undoLog(undo) }, ms: 9000 });
    } catch (e) {
      console.warn('save log', e);
    } finally {
      S.saving = false;
      $('#saveLog').disabled = false;
    }
  }
  async function logToCalendar(logId, log) {
    if (!S.settings.logToCalendar) return null;
    if (!S.mcp) {
      // the stand-alone app without Google sign-in has no calendar at all: nothing to retry
      if (!SA) await write('logs/' + logId, (ref) => ref.update({ calendar: { ok: false, error: 'unavailable' } })).catch(() => {});
      return null;
    }
    const p = projById(log.projectId);
    const input = {
      summary: log.title + (p ? ' · ' + (p.short || p.name) : ''),
      startTime: log.date + 'T' + log.start + ':00',
      endTime: (log.endDate || log.date) + 'T' + log.end + ':00',
      description: [LOG_MARK + '.', p ? 'Project: ' + p.name : '', 'Time: ' + fmtMin(log.minutes) + (log.done ? ' (finished)' : ''), log.text ? 'Note: ' + log.text : ''].filter(Boolean).join('\n'),
      availability: 'AVAILABILITY_FREE',
      colorId: String(S.settings.logColorId || '8'),
      useDefaultReminders: false,
    };
    if (S.settings.logCalendarId) input.calendarId = S.settings.logCalendarId;
    try {
      const res = await S.mcp.callTool(CAL, 'create_event', input);
      const id = eventIdFrom(res && res.payload);
      await write('logs/' + logId, (ref) => ref.update({ calendar: { ok: true, id: id || null, calendarId: S.settings.logCalendarId || '' } })).catch(() => {});
      return id;
    } catch (e) {
      console.warn('calendar', e);
      await write('logs/' + logId, (ref) => ref.update({ calendar: { ok: false, error: (e && e.code) || 'error' } })).catch(() => {});
      toast('Saved, but not on your calendar. ' + calCopy(e), { bad: true, ms: 9000 });
      return null;
    }
  }
  async function deleteCalEvent(cal, quiet) {
    if (!cal || !cal.id || !S.mcp) return;
    const input = { eventId: cal.id };
    if (cal.calendarId) input.calendarId = cal.calendarId;
    try { await S.mcp.callTool(CAL, 'delete_event', input); }
    catch (e) { if (!quiet) toast('Log removed, but the calendar entry stayed. ' + calCopy(e), { bad: true, ms: 9000 }); }
  }
  async function undoLog(u) {
    try {
      const eventId = u.calP ? await u.calP : null;
      if (u.logId) await write('logs/' + u.logId, (ref) => ref.delete());
      if (u.taskPrev) await write('tasks/' + u.taskPrev.id, (ref) => ref.update({ status: u.taskPrev.status, doneAt: u.taskPrev.doneAt }));
      if (u.newTaskId) await write('tasks/' + u.newTaskId, (ref) => ref.delete());
      if (eventId) await deleteCalEvent({ id: eventId, calendarId: S.settings.logCalendarId || '' });
      toast('Undone.');
    } catch (e) { console.warn('undo', e); }
  }
  async function deleteLog(id) {
    const l = S.logs.find((x) => x.id === id);
    if (!l) return;
    await write('logs/' + id, (ref) => ref.delete()).catch(() => null);
    if (l.calendar && l.calendar.ok) await deleteCalEvent(l.calendar);
    toast('Log deleted.');
  }
  async function retryCalendar(id) {
    const l = S.logs.find((x) => x.id === id);
    if (!l) return;
    const endDate = l.end < l.start ? E.addDays(l.date, 1) : l.date;
    const ok = await logToCalendar(id, Object.assign({}, l, { endDate }));
    if (ok !== null || (S.logs.find((x) => x.id === id) || {}).calendar) toast('Calendar updated.');
  }

  // ---------- timer ----------
  async function startTimer(taskId, title) {
    if (S.timer) { toast('A timer is already running for ' + S.timer.title + '. Stop it first.', { action: { label: 'Stop and log', fn: stopTimer } }); return; }
    await write('timer/current', (ref) => ref.set({ taskId: taskId || null, title: title || 'Untitled', startedAt: new Date().toISOString() })).catch(() => {});
  }
  function stopTimer() {
    const t = S.timer;
    if (!t) return;
    const started = new Date(t.startedAt);
    const mins = Math.max(1, Math.round((Date.now() - started.getTime()) / 60000));
    S.draft = { parsed: null, over: {}, timer: { taskId: t.taskId, title: t.title, minutes: mins, start: hm(started), date: localDate(started) } };
    $('#logText').value = t.title + ', ' + fmtMin(mins);
    autoGrow();
    parseNow();
    renderPreview(true);
    write('timer/current', (ref) => ref.delete()).catch(() => {});
    S.timer = null;
    renderTimer();
    $('#saveLog').focus();
  }
  function renderTimer() {
    const pill = $('#timerPill');
    const t = S.timer;
    pill.hidden = !t;
    $('#timerStart').hidden = !!t;
    if (t) tickTimer();
  }
  function tickTimer() {
    const t = S.timer;
    if (!t) return;
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(t.startedAt)) / 1000));
    $('#timerTxt').textContent = t.title + ' · ' + Math.floor(s / 3600) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }

  // ---------- planning ----------
  async function planDay(date) {
    if (!S.db) { toast(SA ? NO_DB : 'Open this logbook in claude.ai to plan.', { bad: true }); return; }
    S.busy.plan = true;
    render();
    const s = S.settings;
    const today = S.today;
    const errors = [];
    let events = [];
    let read = 0;
    if (S.mcp) {
      const cals = s.busyCalendars.length ? s.busyCalendars : [''];
      const results = await Promise.allSettled(cals.map((id) => {
        const input = { startTime: date + 'T00:00:00', endTime: E.addDays(date, 1) + 'T00:00:00', orderBy: 'startTime', pageSize: 100 };
        if (id) input.calendarId = id;
        return calRead('list_events', input);
      }));
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          read++;
          const p = r.value && r.value.payload;
          const evs = (p && Array.isArray(p.events) && p.events) || [];
          for (const ev of evs) {
            const desc = ev.description || '';
            if (desc.includes(LOG_MARK) || desc.includes(PLAN_MARK)) continue;
            const me = (ev.attendees || []).find((x) => x.self);
            const c = D.clipEvent(ev, date);
            if (!c) continue;
            if (me && (me.responseStatus === 'declined' || me.responseStatus === 'needsAction')) c.busy = false;
            events.push(c);
          }
        } else errors.push((cals[i] || 'Primary calendar') + ': ' + calCopy(r.reason));
      });
    } else errors.push("Couldn't read your calendars here, so the plan only uses your day window.");
    const seen = new Set();
    events = events.filter((e) => { const k = e.title + e.start + e.end; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.startMin - b.startMin);
    const nowM = date === today ? minOfDay(new Date()) : 0;
    const blocks = D.freeBlocks(events, { dayStart: s.dayStart, dayEnd: s.dayEnd, bufferMin: num(s.bufferMin) ?? 10, minBlockMin: num(s.minBlockMin) ?? 25, nowMin: nowM });
    const freeH = blocks.reduce((a, b) => a + b.minutes, 0) / 60;
    const used = date === today ? S.todayUsed : 0;
    const availH = Math.max(0, Math.min(freeH, dayTarget(date) - used));
    const es = engineSettings();
    const factor = es.factor || 1;
    const settings = Object.assign({}, es, { overrides: Object.assign({}, es.overrides, { [date]: availH / factor }) });
    const archived = archivedSet();
    const tasks = Object.values(S.tx).filter((t) => !archived.has(t.projectId));
    let slots = [];
    try {
      const fc = E.forecast({ tasks, projects: activeProjects(), today: date, settings, calibration: S.calib, quantile: quantile(), todayUsed: 0 });
      slots = D.assign(blocks, E.todayPlan(fc, availH));
    } catch (e) { errors.push('Schedule error: ' + ((e && e.message) || e)); }
    let calEvents = (S.plans[date] && S.plans[date].calEvents) || [];
    let onCal = false;
    if (S.settings.planToCalendar && S.mcp && read) {
      const r = await syncPlanCalendar(date, slots);
      calEvents = r.events;
      if (r.error) errors.push('The plan is here but not on your calendar. ' + r.error);
      else onCal = slots.length > 0;
    }
    const plan = {
      date, createdAt: new Date().toISOString(), targetH: dayTarget(date), freeH: r1(freeH), availH: r1(availH),
      events: events.map((e) => ({ title: e.title, start: e.start, end: e.end, busy: e.busy })),
      blocks: slots.map((b) => ({ taskId: b.taskId, title: b.title, start: b.start, end: b.end, minutes: b.minutes })),
      calendarsRead: read, calendarErrors: errors, calEvents,
    };
    try { await write('plans/' + date, (ref) => ref.set(plan)); S.plans[date] = plan; } catch (e) { /* toast shown */ }
    S.busy.plan = false;
    render();
    const nSlots = new Set(slots.map((b) => b.start)).size;
    if (!errors.length) toast(slots.length ? 'Planned ' + fmtH(slots.reduce((a, b) => a + b.minutes, 0) / 60) + ' in ' + nSlots + ' slot' + (nSlots === 1 ? '' : 's') + (onCal ? ' and put it on your calendar.' : '.') : availH <= 0 ? 'No project time left for that day.' : 'No free slot long enough. Check the Day window in Setup.');
  }
  // Puts a day's planned blocks on Google Calendar, replacing blocks from the
  // last plan that haven't started yet. Started ones stay as a record.
  async function syncPlanCalendar(date, slots) {
    const prev = (S.plans[date] && S.plans[date].calEvents) || [];
    const cut = date === S.today ? hm(new Date()) : '00:00';
    for (const e of prev) if (e.start >= cut) await deleteCalEvent(e, true);
    const out = prev.filter((e) => e.start < cut);
    const calId = S.settings.logCalendarId || '';
    for (const b of slots) {
      const t = S.tx[b.taskId];
      const p = t && projById(t.projectId);
      const input = {
        summary: b.title + (p ? ' · ' + (p.short || p.name) : ''),
        startTime: date + 'T' + b.start + ':00',
        endTime: date + 'T' + b.end + ':00',
        description: [PLAN_MARK + '.', p ? 'Project: ' + p.name : '', 'Planned: ' + fmtMin(b.minutes), 'Re-plan in the logbook to move it.'].filter(Boolean).join('\n'),
        availability: 'AVAILABILITY_BUSY',
        colorId: String(S.settings.planColorId || '9'),
        useDefaultReminders: false,
      };
      if (calId) input.calendarId = calId;
      try {
        const res = await S.mcp.callTool(CAL, 'create_event', input);
        const id = eventIdFrom(res && res.payload);
        if (id) out.push({ id, calendarId: calId, start: b.start, end: b.end, taskId: b.taskId });
      } catch (e) { return { events: out, error: calCopy(e) }; }
    }
    return { events: out };
  }
  async function clearPlanCal(date) {
    const plan = S.plans[date];
    if (!plan || !(plan.calEvents || []).length || !S.mcp) return;
    const cut = date === S.today ? hm(new Date()) : '00:00';
    for (const e of plan.calEvents) if (e.start >= cut) await deleteCalEvent(e, true);
    await write('plans/' + date, (ref) => ref.update({ calEvents: plan.calEvents.filter((e) => e.start < cut) })).catch(() => {});
    toast('Took the plan off your calendar.');
  }
  async function loadCalendars() {
    S.busy.cals = true;
    render();
    try {
      const res = await calRead('list_calendars', {});
      const p = res && res.payload;
      S.calendars = ((p && p.calendars) || []).map((c) => ({ id: c.id, summary: c.summary }));
    } catch (e) { toast(calCopy(e), { bad: true }); }
    S.busy.cals = false;
    render();
  }

  // ---------- Ask Claude ----------
  async function askClaude() {
    const text = $('#logText').value.trim();
    if (!text || !S.sample) return;
    const btn = $('#askBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
    const now = new Date();
    const archived = archivedSet();
    const projs = activeProjects().map((p) => p.id + ' | ' + p.name + ' | ' + (p.aliases || []).join(', ')).join('\n');
    const tasks = S.tasks.filter((t) => t.status !== 'dropped' && !archived.has(t.projectId))
      .sort((a, b) => (isOpen(a) === isOpen(b) ? 0 : isOpen(a) ? -1 : 1)).slice(0, 150)
      .map((t) => t.id + ' | ' + t.title + ' | ' + (t.projectId || '')).join('\n');
    const prompt = [
      "Read one line from a student's work time log and reply with only a JSON object.",
      'Now: ' + localDate(now) + ' ' + hm(now) + ' (' + now.toLocaleDateString('en-GB', { weekday: 'long' }) + '). Times are 24-hour local time.',
      'Projects (id | name | other names):', projs || '(none)',
      'Tasks (id | title | project id):', tasks || '(none)',
      'Log line: """' + text.replace(/"""/g, '"') + '"""',
      'Reply with {"minutes": number or null, "start": "HH:MM" or null, "dayOffset": 0 or -1, "taskId": an id from the task list or null, "projectId": an id from the project list or null, "newTaskTitle": a short title if no listed task fits, else null, "done": true if the line says the task is finished, false if it says it is not, else null}.',
      'Example: {"minutes": 90, "start": null, "dayOffset": 0, "taskId": null, "projectId": "gearbox", "newTaskTitle": "Gear tooth stress hand calcs", "done": false}',
    ].join('\n');
    try {
      const j = await S.sample.json(prompt, { modelTier: 'quick' });
      if (!j || typeof j !== 'object') throw { code: 'invalid_json' };
      const o = {};
      const m = Number(j.minutes);
      if (isFinite(m) && m > 0 && m <= 960) o.minutes = Math.round(m);
      if (typeof j.start === 'string' && /^\d{2}:\d{2}$/.test(j.start)) o.start = j.start;
      if (j.dayOffset === -1) o.date = E.addDays(localDate(), -1);
      if (j.taskId && S.tx[j.taskId]) o.taskSel = 't:' + j.taskId;
      else if (j.newTaskTitle) { o.taskSel = 'new'; o.newTitle = String(j.newTaskTitle).slice(0, 120); }
      if (j.projectId && projById(j.projectId) && !o.taskSel?.startsWith('t:')) o.projectId = j.projectId;
      if (j.done === true || j.done === false) o.done = j.done;
      Object.assign(S.draft.over, o);
      renderPreview(true);
      toast('Claude filled in the details. Check them, then log it.');
    } catch (e) {
      const code = e && e.code;
      if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) { S.sample = null; toast("Claude isn't available on this page. Fill the fields in by hand.", { bad: true }); }
      else if (code === 'rate_limited') toast('Claude is busy or your usage limit is reached. Fill the fields in by hand.', { bad: true });
      else if (code === 'session_expired') toast('Sign in to claude.ai again, then retry.', { bad: true });
      else if (code !== 'cancelled') toast("Claude couldn't read that line. Fill the fields in by hand.", { bad: true });
      renderPreview(true);
    }
  }

  // ---------- CSV ----------
  function csv(rows) {
    return rows.map((r) => r.map((v, i) => {
      let s = v == null ? '' : String(v);
      if (typeof v === 'string' && /^[=+\-@]/.test(s) && i !== -1) s = "'" + s;
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\n');
  }
  async function exportCsv(kind) {
    if (!S.downloads) return;
    let rows;
    if (kind === 'tasks') {
      rows = [['id', 'title', 'project', 'type', 'status', 'importance', 'priority', 'estimate_h', 'first_estimate_h', 'logged_h', 'deadline', 'not_before', 'waits_on', 'owner', 'forecast_start', 'forecast_finish', 'float_h', 'done_on', 'notes']];
      for (const t of S.tasks) {
        const f = S.fc && S.fc.tasks[t.id];
        rows.push([t.id, t.title, projName(t.projectId), t.category || '', t.status || 'todo', t.importance || 'normal', (QUADS[S.quad[t.id]] || {}).label || '', num(t.estimateH) ?? '', num(t.estimateH0) ?? '', r2((S.tx[t.id] || {}).actualH || 0), t.deadline || '', t.notBefore || '', (t.dependsOn || []).join(' '), t.owner || 'me', f ? f.start || '' : '', f ? f.finish || '' : '', f && f.slackH != null ? f.slackH : '', t.doneAt || '', t.notes || '']);
      }
    } else {
      rows = [['date', 'start', 'end', 'minutes', 'task', 'project', 'finished', 'text']];
      for (const l of S.logs) rows.push([l.date, l.start, l.end, l.minutes, l.title, projName(l.projectId), l.done ? 'yes' : '', l.text || '']);
    }
    try { await S.downloads.save({ filename: 'logbook-' + kind + '-' + S.today + '.csv', data: csv(rows) }); }
    catch (e) { if (e && e.code !== 'declined') toast('Download failed (' + ((e && e.code) || 'error') + ').', { bad: true }); }
  }

  // ---------- full export ----------
  // Every document of every collection in one JSON file (the stand-alone app imports it).
  // The store returns at most 1000 documents a read, so big collections are paged newest
  // first by `field`.
  const EXPORT = [['projects'], ['tasks'], ['logs', 'date'], ['plans', 'date'], ['settings'], ['timer']].concat(SA ? [['analyses']] : []);
  async function getOnce(q) {
    try { return await q.get(); }
    catch (e) {
      if (e && e.code === 'unavailable') { await new Promise((r) => setTimeout(r, 500 + Math.random() * 700)); return q.get(); }
      throw e;
    }
  }
  async function readCollection(col, field) {
    const first = await getOnce(S.db.collection(col).limit(1000));
    const out = new Map(first.docs.map((d) => [d.id, Object.assign({ id: d.id }, d.data())]));
    if (first.size < 1000) return [...out.values()];
    if (!field) throw { code: 'too_many', message: col };
    let q = S.db.collection(col).orderBy(field, 'desc').limit(1000);
    for (let page = 0; page < 500; page++) {
      const snap = await getOnce(q);
      let fresh = 0, last = null;
      for (const d of snap.docs) {
        if (!out.has(d.id)) fresh++;
        out.set(d.id, Object.assign({ id: d.id }, d.data()));
        if (d.data()[field] != null) last = d.data()[field];
      }
      if (snap.size < 1000 || last == null || (page && !fresh)) break;
      q = S.db.collection(col).where(field, '<=', last).orderBy(field, 'desc').limit(1000);
    }
    return [...out.values()];
  }
  async function exportAll() {
    if (!S.downloads || S.busy.export) return;
    if (!S.db) { toast(SA ? NO_DB : 'Export works only when the Logbook is open in claude.ai.', { bad: true }); return; }
    S.busy.export = true;
    render();
    try {
      const collections = {};
      for (const [col, field] of EXPORT) collections[col] = await readCollection(col, field);
      const counts = Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
      const file = { format: 'harveys-logbook', version: 1, exportedAt: new Date().toISOString(), counts, collections };
      await S.downloads.save({ filename: 'logbook-export-' + S.today + '.json', data: JSON.stringify(file, null, 2) });
      toast('Exported ' + counts.tasks + ' tasks, ' + counts.logs + ' logs and ' + counts.plans + ' day plans.');
    } catch (e) {
      const code = e && e.code;
      if (code === 'too_many') toast('Too many ' + e.message + ' to export in one file.' + (SA ? '' : ' Ask Claude in chat.'), { bad: true });
      else if (code !== 'declined') toast('Export failed (' + (code || 'error') + '). Try again.', { bad: true });
    }
    S.busy.export = false;
    render();
  }

  // ---------- toast & tooltip ----------
  let toastT = null;
  function toast(msg, o) {
    o = o || {};
    const el = $('#toast');
    el.className = 'toast' + (o.bad ? ' bad' : '');
    el.textContent = '';
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (o.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.action.label;
      b.onclick = () => { el.hidden = true; o.action.fn(); };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.hidden = true; }, o.ms || 4500);
  }
  function showTip(el, x, y) {
    const k = el.getAttribute('data-tip');
    const t = S.tips[Number(k)];
    if (!t) return;
    const tipEl = $('#tip');
    tipEl.textContent = '';
    const s = document.createElement('strong');
    s.textContent = t.title;
    tipEl.appendChild(s);
    for (const line of t.lines) { if (!line) continue; const d = document.createElement('span'); d.textContent = line; tipEl.appendChild(d); }
    tipEl.hidden = false;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    tipEl.style.left = Math.max(8, left) + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  }

  // ---------- events ----------
  function autoGrow() {
    const ta = $('#logText');
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, Math.max(46, ta.scrollHeight + 2)) + 'px';
  }
  function setView(v) {
    if (!VIEWS.includes(v)) v = 'today';
    S.view = v;
    try { localStorage.setItem('logbook.view', v); } catch (e) { /* storage off */ }
    try { history.replaceState(null, '', '#' + v); } catch (e) { /* ignore */ }
    render();
    window.scrollTo(0, 0);
  }
  function armDanger(btn, label, fn) {
    if (btn.dataset.armed === '1') { btn.dataset.armed = ''; fn(); return; }
    btn.dataset.armed = '1';
    const old = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { if (btn.isConnected && btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = old; } }, 4000);
  }
  function updateTask(id, patch) { return write('tasks/' + id, (ref) => ref.update(patch)).catch(() => {}); }
  function hasPath(fromId, toId, extra) {
    // does fromId (transitively) wait on toId?
    const seen = new Set();
    const stack = [fromId];
    while (stack.length) {
      const id = stack.pop();
      if (id === toId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const t = S.tasks.find((x) => x.id === id);
      const deps = id === extra.id ? extra.deps : (t && t.dependsOn) || [];
      deps.forEach((d) => stack.push(d));
    }
    return false;
  }
  async function saveTaskForm(id) {
    const form = $('#taskForm');
    const t = S.tasks.find((x) => x.id === id);
    if (!form || !t) return;
    const fd = new FormData(form);
    const title = String(fd.get('title') || '').trim();
    if (!title) { $('#taskFormMsg').textContent = 'Give the task a name.'; return; }
    const deps = fd.getAll('dep').map(String);
    const loop = deps.find((d) => hasPath(d, id, { id, deps }));
    if (loop) { $('#taskFormMsg').textContent = '“' + ((S.tx[loop] || {}).title || loop) + '” already waits on this task, so this one can’t wait on it.'; return; }
    const est = num(fd.get('estimateH'));
    const status = String(fd.get('status') || 'todo');
    const owner = String(fd.get('owner') || '').trim();
    const patch = {
      title, projectId: String(fd.get('projectId') || '') || null, category: String(fd.get('category') || '') || null,
      estimateH: est, status, deadline: String(fd.get('deadline') || '') || null, notBefore: String(fd.get('notBefore') || '') || null,
      owner: owner && owner.toLowerCase() !== 'me' ? owner : null, externalDue: String(fd.get('externalDue') || '') || null,
      dependsOn: deps, notes: String(fd.get('notes') || ''), importance: String(fd.get('importance') || 'normal'),
    };
    if (t.estimateBy === 'claude' && est !== num(t.estimateH)) { patch.estimateBy = 'harvey'; patch.estimateH0 = est; }
    else if (num(t.estimateH0) == null && (num(t.estimateH) != null || est != null)) patch.estimateH0 = num(t.estimateH) != null ? num(t.estimateH) : est;
    if (status === 'done' && t.status !== 'done') patch.doneAt = localDate();
    if (status !== 'done') patch.doneAt = null;
    await updateTask(id, patch);
    closeDrawer();
    toast('Task saved.');
  }
  async function deleteTask(id) {
    await write('tasks/' + id, (ref) => ref.delete()).catch(() => {});
    for (const t of S.tasks) if ((t.dependsOn || []).includes(id)) await updateTask(t.id, { dependsOn: t.dependsOn.filter((d) => d !== id) });
    closeDrawer();
    toast('Task deleted.');
  }
  async function saveProjForm(id) {
    const form = $('#projForm');
    if (!form) return;
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) { $('#projFormMsg').textContent = 'Give the project a name.'; return; }
    const ms = [];
    const bad = [];
    for (const line of String(fd.get('milestones') || '').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
      if (m) ms.push({ date: m[1], label: m[2].trim() }); else bad.push(s);
    }
    if (bad.length) { $('#projFormMsg').textContent = 'Start each milestone line with a date like 2026-11-20. Check: ' + bad[0]; return; }
    ms.sort((a, b) => a.date.localeCompare(b.date));
    const patch = {
      name, short: String(fd.get('short') || '').trim() || null, color: Number(fd.get('color')) || null,
      aliases: String(fd.get('aliases') || '').split(',').map((s) => s.trim()).filter(Boolean),
      priority: Number(fd.get('priority')), pacePerWeek: num(fd.get('pacePerWeek')) || null,
      deadline: String(fd.get('deadline') || '') || null, defaultCategory: String(fd.get('defaultCategory') || '') || null,
      milestones: ms, active: fd.get('active') === 'on', folder: String(fd.get('folder') || '') || null,
    };
    await write('projects/' + id, (ref) => ref.update(patch)).catch(() => {});
    closeDrawer();
    toast('Project saved.');
  }
  function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project'; }

  function bindStatic() {
    const ta = $('#logText');
    ta.addEventListener('input', () => {
      S.draft.over = {};
      if (!ta.value.trim()) S.draft.timer = null;
      autoGrow();
      parseNow();
      renderPreview(true);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveLog(); }
    });
    $('#logForm').addEventListener('submit', (e) => { e.preventDefault(); saveLog(); });
    $('#timerStart').addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text) { toast('Type the task first, like “gearbox CAD”, then start the timer.'); ta.focus(); return; }
      parseNow();
      const v = resolved();
      if (v.task) startTimer(v.task.id, v.task.title);
      else startTimer(null, String(v.newTitle || text).replace(/^./, (c) => c.toUpperCase()));
      clearDraft();
    });
    $('#timerStop').addEventListener('click', stopTimer);
    const pv = $('#preview');
    pv.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'pvMin') { S.draft.over.minutes = num(t.value); const d = $('#pvDur'); if (d) d.textContent = S.draft.over.minutes ? fmtMin(S.draft.over.minutes) : 'min'; const en = $('#pvEnd'); if (en) { const v = resolved(); en.textContent = v.start ? 'to ' + endLabel(v) : 'ending now'; } }
      else if (t.id === 'pvNewTitle') S.draft.over.newTitle = t.value;
    });
    pv.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'pvDate') S.draft.over.date = t.value || localDate();
      else if (t.id === 'pvStart') { S.draft.over.start = t.value || ''; const en = $('#pvEnd'); if (en) { const v = resolved(); en.textContent = v.start ? 'to ' + endLabel(v) : 'ending now'; } }
      else if (t.id === 'pvTask') { S.draft.over.taskSel = t.value; if (t.value.startsWith('t:')) delete S.draft.over.projectId; renderPreview(true); const s = $('#pvTask'); if (s) s.focus(); }
      else if (t.id === 'pvProj') S.draft.over.projectId = t.value;
      else if (t.id === 'pvDone') S.draft.over.done = t.checked;
    });
    pv.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); saveLog(); }
    });
    $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setView(b.dataset.view); });
    $('#tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = VIEWS.indexOf(S.view) + (e.key === 'ArrowRight' ? 1 : -1);
      const v = VIEWS[(i + VIEWS.length) % VIEWS.length];
      setView(v);
      $('#tab-' + v).focus();
    });
    document.addEventListener('click', onClick);
    const view = $('#view');
    view.addEventListener('change', onViewChange);
    view.addEventListener('input', (e) => {
      if (e.target.id === 'fQ') { S.filter.q = e.target.value; refreshSheet(); }
      else if (e.target.classList.contains('c-title')) fitTitle(e.target);
    });
    view.addEventListener('submit', onViewSubmit);
    view.addEventListener('focusout', () => setTimeout(() => { if (S.pending && !editingInView() && !$('#drawerRoot').children.length) render(); }, 0));
    view.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.classList || !e.target.classList.contains('cell')) return;
      if (e.target.tagName === 'TEXTAREA') e.preventDefault();
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') e.target.blur();
    });
    $('#drawerRoot').addEventListener('input', (e) => {
      if (e.target.id === 'depFilter') {
        const q = e.target.value.trim().toLowerCase();
        $$('#depList label').forEach((l) => { l.hidden = !!q && !l.dataset.name.includes(q); });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#drawerRoot').children.length) closeDrawer();
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); ta.focus(); }
    });
    document.addEventListener('pointerover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); });
    document.addEventListener('pointermove', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); else $('#tip').hidden = true; });
    document.addEventListener('pointerout', (e) => { if (e.target.closest && e.target.closest('[data-tip]')) $('#tip').hidden = true; });
    document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.bottom); } });
    document.addEventListener('focusout', (e) => { if (e.target.closest && e.target.closest('[data-tip]')) $('#tip').hidden = true; });
    let rt = null;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.view === 'timeline' || S.view === 'insights') render(); }, 200); });
    setInterval(() => {
      tickTimer();
      const d = localDate();
      if (d !== S.today) changed();
    }, 1000);
  }
  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const id = b.dataset.id;
    switch (act) {
      case 'close': closeDrawer(); break;
      case 'planday': S.planDay = b.dataset.day; S.planDayFor = S.today; render(); break;
      case 'fquad': S.boardQ = b.dataset.q; render(); break;
      case 'clearplancal': clearPlanCal(b.dataset.date); break;
      case 'target': {
        const date = b.dataset.date;
        const v = Math.max(0, Math.min(16, dayTarget(date) + Number(b.dataset.d)));
        saveSettings({ overrides: Object.assign({}, S.settings.overrides, { [date]: v }) });
        break;
      }
      case 'plan': planDay(b.dataset.date); break;
      case 'timer': { const t = S.tx[id]; if (t) startTimer(t.id, t.title); break; }
      case 'prefill': {
        const t = S.tx[id];
        if (!t) break;
        const ta = $('#logText');
        ta.value = t.title + ', ' + fmtMin(Number(b.dataset.min) || 30);
        S.draft = { parsed: null, over: { taskSel: 't:' + t.id, minutes: Number(b.dataset.min) || 30 }, timer: null };
        const w = b.dataset.when;
        if (w && /^\d{2}:\d{2}/.test(w)) S.draft.over.start = w.slice(0, 5);
        autoGrow();
        parseNow();
        renderPreview(true);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        ta.focus();
        break;
      }
      case 'dellog': armDanger(b, 'Confirm delete', () => deleteLog(id)); break;
      case 'recal': retryCalendar(id); break;
      case 'goto-noest': S.filter.status = 'noest'; S.filter.project = 'all'; setView('tasks'); break;
      case 'fproj': S.filter.project = id; render(); break;
      case 'edit': taskDrawer(id); break;
      case 'savetask': saveTaskForm(id); break;
      case 'deltask': armDanger(b, 'Confirm delete', () => deleteTask(id)); break;
      case 'tlweeks': S.tl.weeks = Number(b.dataset.w); render(); break;
      case 'tlq': S.tl.quantile = b.dataset.q; recompute(); render(); break;
      case 'setq': S.tl.quantile = null; saveSettings({ quantile: b.dataset.q }); break;
      case 'editproj': projDrawer(id); break;
      case 'saveproj': saveProjForm(id); break;
      case 'loadcals': loadCalendars(); break;
      case 'csv': exportCsv(b.dataset.kind); break;
      case 'exportall': exportAll(); break;
      case 'sync': syncNow(); break;
      case 'gsignout': armDanger(b, 'Confirm sign out', signOutGoogle); break;
      case 'import': { const f = $('#importFile'); if (f) f.click(); break; }
      case 'doimport': doImport(); break;
      case 'swreload': PF && PF.applyUpdate(); break;
      case 'analyze':
        if (!SA) break;
        closeDrawer();
        pickAnTask(id);
        setView('analyze');
        break;
      case 'anask': askAI(); break;
      case 'anstop': if (S.an.run) S.an.run.ctrl.abort(); break;
      case 'aicheck': checkAI(); break;
      case 'goto-ai': gotoAi(); break;
      case 'ask': askClaude(); break;
      default: break;
    }
  }
  function onViewChange(e) {
    const t = e.target;
    if (t.classList && t.classList.contains('b-done')) {
      const id = t.dataset.id;
      const task = S.tasks.find((x) => x.id === id);
      if (!task) return;
      updateTask(id, { status: 'done', doneAt: localDate() });
      toast('Ticked off: ' + task.title + '.', { action: { label: 'Undo', fn: () => updateTask(id, { status: task.status || 'todo', doneAt: task.doneAt || null }) } });
      return;
    }
    if (t.id === 'fStatus') { S.filter.status = t.value; refreshSheet(); return; }
    if (SA && (t.id === 'anTask' || t.id === 'aiUrl' || t.id === 'aiModel')) { aiFieldChanged(t); return; }
    if (t.id === 'fSort') { S.filter.sort = t.value; refreshSheet(); return; }
    const row = t.closest('tr[data-id]');
    if (row && t.closest('.sheet')) {
      const id = row.dataset.id;
      const task = S.tasks.find((x) => x.id === id);
      if (!task) return;
      if (t.classList.contains('c-done')) {
        updateTask(id, t.checked ? { status: 'done', doneAt: localDate() } : { status: 'todo', doneAt: null });
        if (t.checked) toast('Ticked off: ' + task.title + '.', { action: { label: 'Undo', fn: () => updateTask(id, { status: task.status || 'todo', doneAt: task.doneAt || null }) } });
      } else if (t.classList.contains('c-title')) {
        const v = t.value.replace(/\s*\n\s*/g, ' ').trim();
        if (v && v !== task.title) updateTask(id, { title: v }); else t.value = task.title;
        fitTitle(t);
      } else if (t.classList.contains('c-imp')) updateTask(id, { importance: t.value });
      else if (t.classList.contains('c-proj')) updateTask(id, { projectId: t.value || null });
      else if (t.classList.contains('c-cat')) updateTask(id, { category: t.value || null });
      else if (t.classList.contains('c-est')) {
        const v = num(t.value);
        const patch = { estimateH: v };
        if (task.estimateBy === 'claude') { patch.estimateBy = 'harvey'; patch.estimateH0 = v; }
        else if (num(task.estimateH0) == null) patch.estimateH0 = num(task.estimateH) != null ? num(task.estimateH) : v;
        updateTask(id, patch);
      } else if (t.classList.contains('c-due')) updateTask(id, { deadline: t.value || null });
      return;
    }
    const key = t.dataset && t.dataset.set;
    if (key) {
      const s = S.settings;
      if (key === 'weekHours') { const wh = s.weekHours.slice(); wh[Number(t.dataset.i)] = Math.max(0, Math.min(16, num(t.value) || 0)); saveSettings({ weekHours: wh }); }
      else if (key === 'categories') saveSettings({ categories: t.value.split(',').map((x) => x.trim()).filter(Boolean) });
      else if (t.type === 'checkbox') saveSettings({ [key]: t.checked });
      else if (key === 'bufferMin' || key === 'minBlockMin') saveSettings({ [key]: num(t.value) ?? DEFAULTS[key] });
      else saveSettings({ [key]: t.value });
      return;
    }
    if (t.dataset && t.dataset.act === 'busycal') {
      const set = new Set(S.settings.busyCalendars);
      if (t.checked) set.add(t.value); else set.delete(t.value);
      saveSettings({ busyCalendars: Array.from(set) });
    }
  }
  async function onViewSubmit(e) {
    e.preventDefault();
    const f = e.target;
    if (f.id === 'addTask') {
      const title = $('#atTitle').value.trim();
      if (!title) return;
      if (!S.db) { toast(NO_DB, { bad: true }); return; }
      const projectId = $('#atProj').value || null;
      const est = num($('#atEst').value);
      const p = projById(projectId);
      const id = uid('t');
      S.lastProj = projectId || '';
      await write('tasks/' + id, (ref) => ref.set({
        title, projectId, estimateH: est, estimateH0: est, deadline: $('#atDue').value || null, status: 'todo',
        category: (p && p.defaultCategory) || null, dependsOn: [], createdBy: 'harvey', createdAt: new Date().toISOString(), order: Date.now(),
      })).then(() => toast('Added: ' + title + '.')).catch(() => {});
      $('#atTitle').value = '';
      $('#atEst').value = '';
      $('#atDue').value = '';
      $('#atTitle').focus();
    } else if (f.classList.contains('qadd')) {
      const input = f.querySelector('input');
      const title = input.value.trim();
      if (!title) return;
      if (!S.db) { toast(NO_DB, { bad: true }); return; }
      const projectId = f.dataset.proj || null;
      const p = projById(projectId);
      input.value = '';
      await write('tasks/' + uid('t'), (ref) => ref.set({
        title, projectId, estimateH: null, estimateH0: null, deadline: null, status: 'todo', importance: 'normal',
        category: (p && p.defaultCategory) || null, dependsOn: [], createdBy: 'harvey', createdAt: new Date().toISOString(), order: Date.now(),
      })).then(() => toast('Added: ' + title + '. Give it an estimate and deadline on the Tasks tab.')).catch(() => {});
    } else if (f.id === 'addProj') {
      const name = $('#apName').value.trim();
      if (!name || !S.db) return;
      let id = slugify(name);
      while (projById(id)) id += '-2';
      const used = new Set(S.projects.map((p) => Number(p.color)));
      let color = 1;
      while (used.has(color) && color < 8) color++;
      await write('projects/' + id, (ref) => ref.set({ name, aliases: [], color, priority: 1, active: true, order: S.projects.length + 1, milestones: [], createdAt: new Date().toISOString() })).catch(() => {});
      $('#apName').value = '';
      toast('Project added. Edit it to add other names and milestones.');
    }
  }

  // ---------- stand-alone app: sync, import, updates ----------
  function agoText(ms) {
    if (!ms) return 'never';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const d = new Date(ms);
    if (localDate(d) === localDate()) return 'at ' + hm(d);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + hm(d);
  }
  function syncErrText(e) {
    const code = e && e.code;
    const msg = String((e && e.message) || '');
    return ({
      needs_reauth: 'Signed out of Google. Tap Sync now to sign in.',
      popup_blocked: 'The browser blocked the Google sign-in window. Allow pop-ups for this site, then tap Sync now.',
      not_granted: (msg || "Google didn't give the Logbook access.") + ' Sign out of Google below, then sign in again and tick every box.',
      wrong_account: msg,
      not_configured: 'Google sign-in is not set up in this copy of the app.',
      offline: "You're offline. It will sync when you're back online.",
      server_unavailable: "Couldn't reach Google. Check the connection.",
      upstream_error: "Google Drive didn't answer. Try again in a moment.",
      bad_file: msg || 'A sync file in Google Drive could not be read.',
      quota_exceeded: "This device's storage is full.",
    })[code] || 'Sync failed: ' + (msg || code || 'unknown error');
  }
  function syncChipState(st) {
    if (!st.configured) return null;
    if (st.syncing) return ['busy', 'Syncing…'];
    if (st.error) return ['bad', st.error.code === 'wrong_account' ? 'Wrong Google account' : 'Sync failed · retry'];
    if (!st.online) return ['wait', 'Offline' + (st.pending ? ' · ' + st.pending + ' to sync' : '')];
    if (!st.signedIn) return st.everSynced ? ['wait', st.pending ? 'Sync · ' + st.pending + ' waiting' : 'Tap to sync'] : ['off', 'Set up sync'];
    if (st.pending) return ['wait', st.pending + (st.pending === 1 ? ' change' : ' changes') + ' to sync'];
    return ['ok', 'Synced ' + agoText(st.lastSync)];
  }
  function renderSync() {
    const el = $('#syncChip');
    if (!el || !PF) return;
    const st = PF.status();
    const c = syncChipState(st);
    el.hidden = !c;
    if (!c) return;
    el.dataset.s = c[0];
    $('.sync-txt', el).textContent = c[1];
    el.setAttribute('aria-label', 'Sync now. ' + c[1]);
    el.title = [st.account ? 'Google account: ' + st.account : 'Not signed in to Google on this device', st.lastSync ? 'Last synced ' + agoText(st.lastSync) : '', st.error ? syncErrText(st.error) : ''].filter(Boolean).join('\n');
    el.disabled = st.syncing;
  }
  function saBanners() {
    const st = PF.status();
    const b = [];
    if (!st.persistent) b.push('<div class="banner bad">This browser isn\'t letting the Logbook save on this device (a private window, or site data blocked), so nothing typed here is kept.</div>');
    if (st.update) b.push('<div class="banner sa-banner"><span>A new version of the Logbook is ready.</span><button type="button" class="btn small primary" data-act="swreload">Reload to update</button></div>');
    if (st.empty && !st.everSynced && loaded()) {
      b.push(`<div class="banner sa-banner welcome"><p><strong>Bring your logbook in.</strong> On your first device, import the file you saved from the claude.ai Logbook (Setup › Your data › Export everything).${st.configured ? ' On your other devices, sync from Google Drive instead.' : ''}</p>
        <div class="inline"><button type="button" class="btn small primary" data-act="import">Import a file</button>${st.configured ? '<button type="button" class="btn small" data-act="sync">Sync from Google Drive</button>' : ''}</div></div>`);
    }
    return b.join('');
  }
  function setupSyncPanel() {
    const st = PF.status();
    let h = '<section class="panel"><div class="panel-h"><h3>Sync</h3>';
    if (!st.configured) return h + '</div><p class="muted">Sync and Google Calendar are off: this copy of the app has no Google sign-in client yet (config.js). Everything else works on this device, and Export everything (below) makes a backup file.</p></section>';
    h += `<button type="button" class="btn small primary" data-act="sync" ${st.syncing ? 'disabled' : ''}>${st.syncing ? 'Syncing…' : 'Sync now'}</button></div>`;
    const bits = [st.account ? 'Google account: <strong>' + esc(st.account) + '</strong>.' : 'Not signed in to Google on this device yet.'];
    if (st.lastSync) bits.push('Last synced ' + esc(agoText(st.lastSync)) + '.');
    if (st.pending) bits.push(st.pending + (st.pending === 1 ? ' change' : ' changes') + ' waiting to sync.');
    h += '<p>' + bits.join(' ') + '</p>';
    if (st.error) h += '<p style="margin-top:6px;color:var(--crit-ink)">' + esc(syncErrText(st.error)) + '</p>';
    h += '<p class="muted" style="margin-top:8px">Your logbook lives in this browser on each device. Sync copies it to a hidden app folder in your Google Drive that only this app can open, so your laptop and phone match. Google asks you to confirm about once an hour, the next time you sync or use your calendar.</p>';
    if (st.account) h += '<div class="inline" style="margin-top:10px"><button type="button" class="btn small" data-act="gsignout">Sign out of Google</button><span class="muted">Everything stays on this device. Use it to switch accounts.</span></div>';
    return h + '</section>';
  }
  async function syncNow() {
    if (!PF) return;
    try {
      const r = await PF.sync();
      toast(r && r.pulled ? 'Synced: ' + r.pulled + (r.pulled === 1 ? ' change' : ' changes') + ' from your other devices.' : 'Synced.');
    } catch (e) {
      toast(syncErrText(e), { bad: true, ms: 8000 });
    }
  }
  async function signOutGoogle() {
    await PF.signOut();
    toast('Signed out of Google. Everything stays on this device.');
    render();
  }
  async function importChosen(file) {
    if (!file || !PF) return;
    let plan;
    try { plan = PF.readImport(await file.text()); }
    catch (e) { toast((e && e.message) || "Couldn't read that file.", { bad: true, ms: 8000 }); return; }
    S.importPlan = plan;
    const c = plan.counts;
    const n = (k, one, many) => { const v = c[k] || 0; return v + ' ' + (v === 1 ? one : many); };
    const at = Date.parse(plan.exportedAt || '');
    const when = isNaN(at) ? '' : ', exported ' + new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const any = plan.add + plan.update;
    openDrawer(`<header><h2 id="drawerTitle" style="font-size:1.4rem">Import a logbook file</h2><button type="button" class="btn ghost" data-act="close">Close</button></header>
      <div class="body">
        <p><strong>${esc(file.name)}</strong>${esc(when)}.</p>
        <p>It holds ${n('projects', 'project', 'projects')}, ${n('tasks', 'task', 'tasks')}, ${n('logs', 'log', 'logs')} and ${n('plans', 'day plan', 'day plans')}${c.settings ? ', plus your settings' : ''}.</p>
        <p>On this device it will add <strong>${plan.add}</strong>, update <strong>${plan.update}</strong> and leave <strong>${plan.same}</strong> as they are. Nothing is deleted.</p>
        ${plan.update ? '<p class="muted">An updated item takes the file’s version, so a change made here since that export is replaced.</p>' : ''}
        ${plan.skipped ? '<p class="muted">' + plan.skipped + ' unreadable entries will be skipped.</p>' : ''}
      </div>
      <footer><span></span><div class="inline"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn primary" data-act="doimport" ${any ? '' : 'disabled'}>${any ? 'Import' : 'Nothing new to import'}</button></div></footer>`);
  }
  async function doImport() {
    const plan = S.importPlan;
    if (!plan || !PF) return;
    S.importPlan = null;
    closeDrawer();
    try {
      const n = await PF.applyImport(plan);
      const st = PF.status();
      toast('Imported ' + n + (n === 1 ? ' item.' : ' items.') + (st.configured ? (st.signedIn ? ' Syncing them to Google Drive now.' : ' Tap the sync button to copy them to Google Drive.') : ''), { ms: 7000 });
    } catch (e) {
      toast("Couldn't import: " + ((e && (e.message || e.code)) || 'unknown error'), { bad: true, ms: 8000 });
    }
  }
  function bootStandalone() {
    document.documentElement.classList.add('sa');
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'importFile';
    input.accept = '.json,application/json';
    input.hidden = true;
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; importChosen(f); });
    document.body.appendChild(input);
    // banners and the Setup panel only need a fresh render when one of these changes
    let key = '';
    PF.onStatus((st) => {
      renderSync();
      const k = [st.persistent, st.update, st.empty && !st.everSynced, st.configured].join() +
        (S.view === 'setup' ? '|' + [st.syncing, st.account, st.pending, st.error && st.error.code, Math.floor((st.lastSync || 0) / 60000)].join() : '');
      if (k !== key) { key = k; if (loaded()) render(); }
    });
    setInterval(renderSync, 20 * 1000);
    renderSync();
  }

  // ---------- Analyze (stand-alone app) ----------
  // One task's facts, worked out on the device. The local AI sees exactly
  // these lines and nothing else, and only when Harvey presses Ask the AI.
  const AN_V = 1;
  const AN_SYSTEM = [
    "You are a planning coach inside Harvey's Logbook, his planner for coursework, placement applications and projects.",
    'You are given facts about ONE task, worked out by the app from his logs and estimates.',
    'Using only those facts, write:',
    '1. Where the task stands, in one or two sentences.',
    '2. The biggest risk, with the number behind it. Leave this out if there is no real risk.',
    '3. Two or three concrete next steps, each with a time or a date.',
    'Keep it under 150 words. Plain British English, short sentences, no preamble.',
    'Never invent numbers, dates or facts that are not in the facts.',
  ].join('\n');
  const STATUS_LABEL = { todo: 'To do', doing: 'In progress', done: 'Done', dropped: 'Dropped' };
  const oneLine = (v, n) => { const x = String(v || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  function relDays(date) {
    const d = E.daysBetween(S.today, date);
    return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d > 0 ? 'in ' + d + ' days' : -d + ' days ago';
  }
  function hashStr(x) { // FNV-1a, 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  function anTasks() {
    const archived = archivedSet();
    const mine = S.tasks.filter((t) => isMine(t) && t.status !== 'dropped' && !archived.has(t.projectId));
    const done = mine.filter((t) => t.status === 'done').sort((a, b) => String(b.doneAt || '').localeCompare(String(a.doneAt || ''))).slice(0, 30);
    return { open: mine.filter(isOpen), done };
  }
  // the most pressing open task: Do first before Schedule, then the nearest deadline
  function anDefault(open) {
    const key = (t) => [QORDER[S.quad[t.id]] ?? 9, (S.fc && S.fc.tasks[t.id] && S.fc.tasks[t.id].deadline) || t.deadline || '9999'];
    return open.slice().sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || String(x[1]).localeCompare(String(y[1])) || byOrder(a, b); })[0] || null;
  }
  function pickAnTask(id) {
    S.an.taskId = id;
    S.an.err = null;
    try { localStorage.setItem('logbook.analyze', id); } catch (e) { /* storage off */ }
  }
  function anOptions(list, sel) {
    let h = '';
    const listed = new Set();
    const groups = activeProjects().map((p) => [p.name, list.open.filter((t) => t.projectId === p.id)]);
    groups.push(['No project', list.open.filter((t) => !projById(t.projectId))]);
    for (const [name, ts] of groups) {
      if (!ts.length) continue;
      h += `<optgroup label="${esc(name)}">` + ts.sort(byOrder).map((t) => { listed.add(t.id); return opt(t.id, t.title, sel); }).join('') + '</optgroup>';
    }
    if (list.done.length) h += '<optgroup label="Finished">' + list.done.map((t) => { listed.add(t.id); return opt(t.id, t.title, sel); }).join('') + '</optgroup>';
    if (sel && !listed.has(sel) && S.tx[sel]) h = opt(sel, S.tx[sel].title, sel) + h;
    return h;
  }
  function anFacts(t) {
    const f = S.fc && S.fc.tasks[t.id];
    const p = projById(t.projectId);
    const rows = [];
    const add = (k, v) => { if (v != null && v !== '') rows.push([k, String(v)]); };
    const logs = S.logs.filter((l) => l.taskId === t.id).sort((a, b) => String(b.date + (b.start || '')).localeCompare(String(a.date + (a.start || ''))));
    const loggedH = S.loggedByTask[t.id] || 0;
    // S.tx already adds the logs to actualH; the stored figure is the baseline from before logging
    const raw = S.tasks.find((x) => x.id === t.id) || t;
    const baseH = num(raw.actualH) || 0;
    const open = isOpen(t);
    add('Today', dayName(S.today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    add('Project', p ? p.name + (p.deadline ? ', project deadline ' + dayName(p.deadline) : '') : 'none');
    add('Status', (STATUS_LABEL[t.status] || 'To do') + (t.status === 'done' && t.doneAt ? ', finished ' + dayName(t.doneAt) : '') + (isMine(t) ? '' : ", " + t.owner + "'s task"));
    const q = QUADS[S.quad[t.id]];
    add('Priority', (q ? q.label + ', ' : '') + (t.importance || 'normal') + ' importance');
    add('Type of work', t.category);
    const dl = (f && f.deadline) || t.deadline;
    if (dl) add('Deadline', dayName(dl) + ' (' + relDays(dl) + ')' + (f && f.softDeadline ? ", a soft date from the project's weekly pace" : !t.deadline ? ", the project's deadline" : ''));
    if (t.notBefore && t.notBefore > S.today) add("Can't start before", dayName(t.notBefore));
    if (!isMine(t) && t.externalDue) add('Their due date', dayName(t.externalDue) + ' (' + relDays(t.externalDue) + ')');
    const est = num(t.estimateH), est0 = num(t.estimateH0);
    add('Estimate', est == null ? 'none yet' : fmtH(est) + (est0 != null && est0 !== est ? ' (first estimate ' + fmtH(est0) + ')' : '') + (t.estimateBy === 'claude' ? ', a guess by Claude' : ''));
    let spent = logs.length ? fmtH(loggedH) + ' in ' + logs.length + (logs.length === 1 ? ' session, ' + dayName(logs[0].date) : ' sessions, ' + dayName(logs[logs.length - 1].date) + ' to ' + dayName(logs[0].date)) : 'nothing logged yet';
    if (baseH) spent += ', plus ' + fmtH(baseH) + ' from before logging';
    add('Time spent', spent);
    if (logs.length) {
      const a = E.addDays(S.today, -13), b = E.addDays(S.today, -27);
      const sum = (from, to) => logs.filter((l) => l.date >= from && l.date <= to).reduce((n, l) => n + (l.minutes || 0), 0) / 60;
      add('Last 14 days', fmtH(sum(a, S.today)) + ' (the 14 days before: ' + fmtH(sum(b, E.addDays(a, -1))) + ')');
    }
    const cat = t.category || 'other';
    const c = S.calib && ((S.calib.byCat && S.calib.byCat[cat]) || S.calib.global);
    if (c) add('Your track record', c.n ? (c.category === 'all' ? 'Your tasks' : cat + ' tasks') + ' take ×' + r2(c.p50) + ' your estimate (×' + r2(c.p80) + ' to be safe), from ' + c.n + ' finished' : 'no finished tasks with estimates yet, so the app assumes ×' + r2(c.p50));
    if (f && open && isMine(t)) {
      // with no estimate the schedule pencils in a placeholder, so its numbers are only rough
      const rough = est == null;
      add('Work left', rough ? 'unknown until it has an estimate' : fmtH(f.remainingH) + ' at your usual overrun (×' + r2(f.multiplier) + ' on the estimate)');
      add('Forecast', f.finish ? 'start ' + dayName(f.start) + ', finish ' + dayName(f.finish) + ', at your weekly hours' + (rough ? " (rough: there's no estimate)" : '') : "can't be placed in the schedule yet: it waits on something");
      if (dl) add('Spare before the deadline', f.late ? 'none: forecast to finish late' : f.slackH != null ? fmtH(Math.max(0, f.slackH)) + ' of planned work time' : null);
      if (f.latestStart) add('Latest start to make it', f.latestStart >= S.today ? dayName(f.latestStart) + ' (' + relDays(f.latestStart) + ')' : 'already passed (' + dayName(f.latestStart) + ')');
    } else if (t.status === 'done' && est) {
      const actual = baseH + loggedH;
      if (actual) add('Actual against estimate', fmtH(actual) + ' against ' + fmtH(est) + ' (×' + r2(actual / est) + ')');
    }
    const deps = (t.dependsOn || []).map((id) => S.tx[id]).filter(Boolean);
    if (deps.length) add('Waits on', deps.map((d) => oneLine(d.title, 80) + ' (' + (d.status === 'done' ? 'done' : isMine(d) ? (STATUS_LABEL[d.status] || 'To do').toLowerCase() : d.owner + "'s, due " + (d.externalDue ? dayName(d.externalDue) : 'no date')) + ')').join('; '));
    const holds = open ? S.tasks.filter((y) => isOpen(y) && (y.dependsOn || []).includes(t.id)) : [];
    if (holds.length) add('Holds up', holds.map((y) => oneLine(y.title, 80)).join('; '));
    if (S.critSet.has(t.id)) add('Critical path', 'yes: a delay here delays the end of ' + (p ? p.name : 'the project'));
    if (t.notes) add('Notes', oneLine(t.notes, 300));
    const sessions = logs.slice(0, 8).map((l) => ({ date: l.date, minutes: l.minutes || 0, text: oneLine(l.text || l.title, 160), done: !!l.done }));
    return { rows, sessions };
  }
  function anInput(t, facts) {
    const lines = ['Task: ' + oneLine(t.title, 200)];
    for (const [k, v] of facts.rows) lines.push(k + ': ' + v);
    if (facts.sessions.length) {
      lines.push('Recent sessions, newest first:');
      for (const x of facts.sessions) lines.push('- ' + dayName(x.date) + ', ' + fmtMin(x.minutes) + (x.text ? ': "' + x.text + '"' : '') + (x.done ? ' (ticked off)' : ''));
    }
    const text = lines.join('\n');
    return { text, hash: hashStr(AN_V + '\n' + text) };
  }
  // the little markdown small models write: paragraphs, lists, bold, code
  function mdLite(src) {
    let h = '', list = null, para = [];
    const inline = (x) => esc(x).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const flush = () => { if (para.length) { h += '<p>' + para.map(inline).join(' ') + '</p>'; para = []; } };
    const close = () => { if (list) { h += '</' + list + '>'; list = null; } };
    const item = (kind, x) => { flush(); if (list !== kind) { close(); h += '<' + kind + '>'; list = kind; } h += '<li>' + inline(x) + '</li>'; };
    for (const raw of String(src || '').replace(/\r/g, '').split('\n')) {
      const l = raw.trim();
      let m;
      if (!l) { flush(); close(); } else if ((m = /^#{1,6}\s+(.*)$/.exec(l))) { flush(); close(); h += '<p><strong>' + inline(m[1].replace(/\*\*/g, '')) + '</strong></p>'; } else if ((m = /^[-*•]\s+(.*)$/.exec(l))) item('ul', m[1]);
      else if ((m = /^\d+[.)]\s+(.*)$/.exec(l))) item('ol', m[1]);
      else { close(); para.push(l); }
    }
    flush();
    close();
    return h;
  }
  function aiErrText(e) {
    const code = e && e.code;
    const url = (e && e.url) || (AI && AI.config().url) || '';
    return ({
      bad_address: 'Use this computer (http://localhost:11434) or a Tailscale address ending in .ts.net. The app is not allowed to reach anywhere else.',
      unreachable: "Couldn't reach the AI at " + url + '. Check Ollama is running (its icon sits in the taskbar). If Chrome asked about apps on this device, choose Allow: address bar › site settings › Local network access.',
      blocked: 'Ollama is running but turned this site away. Set OLLAMA_ORIGINS to ' + location.origin + ' and restart Ollama (steps below in Setup › Local AI).',
      model_missing: 'That model is not installed. In PowerShell run: ollama pull ' + ((AI && AI.config().model) || (AI && AI.DEFAULT_MODEL)) + ', then try again.',
      no_models: 'Ollama has no models yet. In PowerShell run: ollama pull ' + (AI ? AI.DEFAULT_MODEL : '') + ', then press Check connection.',
      aborted: 'Stopped.',
    })[code] || 'The AI ran into a problem: ' + oneLine((e && e.message) || code || 'unknown error', 200);
  }
  function runHtml(run) {
    if (run.text) return mdLite(run.text);
    const secs = (Date.now() - run.t0) / 1000;
    return '<p class="muted">' + (run.thinking ? 'Thinking…' : secs > 8 ? 'Loading the model. The first ask after a break takes longest…' : 'Asking…') + '</p>';
  }
  let paintQ = 0;
  function paintRun() {
    if (paintQ) return;
    paintQ = requestAnimationFrame(() => {
      paintQ = 0;
      const el = $('#anOut');
      if (el && S.an.run) el.innerHTML = runHtml(S.an.run);
    });
  }
  function viewAnalyze() {
    const list = anTasks();
    let t = S.tx[S.an.taskId];
    if (!t || t.status === 'dropped') {
      let id = null;
      try { id = localStorage.getItem('logbook.analyze'); } catch (e) { /* storage off */ }
      t = id && S.tx[id] && S.tx[id].status !== 'dropped' ? S.tx[id] : anDefault(list.open) || list.done[0] || null;
      S.an.taskId = t ? t.id : null;
    }
    if (!t) return '<section class="panel"><div class="panel-h"><h3>Analyze</h3></div><p class="empty">No tasks yet. Add one in Tasks, then come back here to see how it is going.</p></section>';
    const facts = anFacts(t);
    const input = anInput(t, facts);
    const saved = S.analyses[t.id];
    const cfg = AI.config();
    const run = S.an.run && S.an.run.taskId === t.id ? S.an.run : null;
    const err = !run && S.an.err && S.an.err.taskId === t.id ? S.an.err.e : null;
    const hide = new Set(['Today', 'Project', 'Status', 'Priority']);
    let h = `<section class="panel an-pick"><label class="f"><span>Task to analyze</span><select class="field" id="anTask">${anOptions(list, t.id)}</select></label>
      <p class="muted">Worked out on this device from your logs and estimates. The AI sees only this card, and only when you ask it.</p></section>`;
    h += `<section class="panel an-card"><div class="an-head"><h2>${esc(t.title)}</h2><div class="an-pills">${projTag(t.projectId)}${quadPill(t.id)}<span class="pill plain">${esc(STATUS_LABEL[t.status] || 'To do')}</span></div></div>
      <dl class="an-facts">${facts.rows.filter(([k]) => !hide.has(k)).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
    if (facts.sessions.length) h += `<h4 class="an-sub">Recent sessions</h4><ul class="an-logs">${facts.sessions.map((x) => `<li><span class="num">${esc(dayName(x.date))}</span><span class="num">${esc(fmtMin(x.minutes))}</span><span>${esc(x.text || '–')}${x.done ? ' <span class="pill good">Ticked off</span>' : ''}</span></li>`).join('')}</ul>`;
    h += '</section>';
    let btn;
    if (run) btn = '<button type="button" class="btn" data-act="anstop">Stop</button>';
    else if (cfg.ready && cfg.model) btn = `<button type="button" class="btn primary" data-act="anask" ${S.an.run ? 'disabled' : ''}>${saved ? 'Ask again' : 'Ask the AI'}</button>`;
    else btn = '<button type="button" class="btn" data-act="goto-ai">Set up the local AI</button>';
    h += `<section class="panel an-ai"><div class="panel-h"><h3>AI read</h3>${btn}</div>`;
    if (run) h += `<div class="an-out" id="anOut" aria-live="polite" aria-busy="true">${runHtml(run)}</div>`;
    else {
      if (err) h += `<p class="an-err">${esc(aiErrText(err))}</p>`;
      if (saved && saved.text) {
        const stale = saved.inputHash !== input.hash;
        h += `<div class="an-out">${mdLite(saved.text)}</div><p class="muted an-meta">${esc(saved.model || 'Local AI')} · ${esc(timeAgo(saved.createdAt))}${saved.ms ? ' · took ' + Math.max(1, Math.round(saved.ms / 1000)) + ' s' : ''}${stale ? ' · <strong>Your numbers have changed since.</strong> Ask again for a fresh read.' : ''}</p>`;
      } else if (!err) {
        h += cfg.ready ? `<p class="muted">Ask for a short read of where this task stands, its main risk and your next steps. It runs on this computer with ${esc(cfg.model)}, usually in under a minute.</p>`
          : '<p class="muted">No local AI is set up on this device. On your laptop, Setup › Local AI takes you through it (about 10 minutes, free). Reads made there show here after a sync.</p>';
      }
    }
    h += `<details class="an-sees"><summary>What the AI sees</summary><pre>${esc(input.text)}</pre></details></section>`;
    return h;
  }
  async function askAI() {
    if (!AI || S.an.run) return;
    const t = S.tx[S.an.taskId];
    if (!t) return;
    const cfg = AI.config();
    if (!cfg.ready || !cfg.model) { gotoAi(); return; }
    const input = anInput(t, anFacts(t));
    const run = { taskId: t.id, text: '', thinking: false, t0: Date.now(), ctrl: new AbortController() };
    S.an.run = run;
    S.an.err = null;
    render();
    const tick = setInterval(paintRun, 1000);
    try {
      const r = await AI.chat({
        url: cfg.url, model: cfg.model, signal: run.ctrl.signal,
        messages: [{ role: 'system', content: AN_SYSTEM }, { role: 'user', content: input.text }],
        onText: (text, thinking) => { run.text = text; run.thinking = thinking; paintRun(); },
      });
      if (!r.text) throw { code: 'ai_error', message: 'The model sent back an empty answer.' };
      const doc = { taskId: t.id, model: cfg.model, inputHash: input.hash, text: r.text.slice(0, 8000), createdAt: new Date().toISOString(), ms: r.ms };
      if (r.tokens) doc.tokens = r.tokens;
      S.analyses[t.id] = doc;
      if (S.db) write('analyses/' + t.id, (ref) => ref.set(doc)).catch(() => {});
    } catch (e) {
      S.an.err = { taskId: t.id, e: e || { code: 'ai_error' } };
    } finally {
      clearInterval(tick);
      S.an.run = null;
      render();
    }
  }
  function gotoAi() {
    setView('setup');
    const p = $('#aiPanel');
    if (p) p.scrollIntoView({ block: 'start' });
  }
  function setupAiPanel() {
    const cfg = AI.config();
    const chk = S.ai || {};
    const models = (chk.ok && chk.ok.models) || [];
    if (cfg.model && models.length && !models.some((m) => m.name === cfg.model)) models.unshift({ name: cfg.model, size: 0, params: 'not installed' });
    const size = (b) => (b ? ' · ' + (b / 1e9).toFixed(1) + ' GB' : '');
    let h = `<section class="panel" id="aiPanel"><div class="panel-h"><h3>Local AI</h3><button type="button" class="btn small primary" data-act="aicheck" ${chk.busy ? 'disabled' : ''}>${chk.busy ? 'Checking…' : 'Check connection'}</button></div>
      <p class="muted">Analyze can ask an AI model running on this computer (Ollama, free). It runs only when you press Ask the AI, sees only that task's card, and nothing leaves the computer.</p>
      <div class="inline" style="margin-top:10px">
        <label class="f"><span>Address</span><input class="field" id="aiUrl" value="${esc(cfg.url)}" spellcheck="false" autocomplete="off" style="width:min(250px,100%)"></label>
        <label class="f"><span>Model</span>${models.length ? `<select class="field" id="aiModel">${models.map((m) => opt(m.name, m.name + (m.params ? ' · ' + m.params : '') + size(m.size), cfg.model)).join('')}</select>` : `<input class="field" id="aiModel" value="${esc(cfg.model)}" placeholder="${esc(AI.DEFAULT_MODEL)}" spellcheck="false" autocomplete="off" style="width:min(200px,100%)">`}</label>
      </div>`;
    if (chk.err) h += `<p class="an-err" style="margin-top:10px">${esc(aiErrText(chk.err))}</p>`;
    else if (chk.ok) h += `<p style="margin-top:10px">Connected${chk.ok.version ? ' to Ollama ' + esc(chk.ok.version) : ''}. Analyze will use <strong>${esc(cfg.model)}</strong>.${chk.note ? ' ' + esc(chk.note) : ''}</p>`;
    else h += `<p class="muted" style="margin-top:10px">${cfg.ready && cfg.model ? 'Set up on this device: Analyze uses <strong>' + esc(cfg.model) + '</strong>.' : 'Not set up on this device yet.'}</p>`;
    h += `<details class="an-steps"${cfg.ready ? '' : ' open'}><summary>How to set it up on your laptop (10 minutes)</summary><ol>
        <li>Install Ollama from <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a> (Windows) and open it.</li>
        <li>In PowerShell, run <code>ollama pull ${esc(AI.DEFAULT_MODEL)}</code>. It downloads 3 to 4 GB.</li>
        <li>Let this site use it: Windows Settings › search “environment variables” › <em>Edit environment variables for your account</em> › New. Name <code>OLLAMA_ORIGINS</code>, value <code>${esc(location.origin)}</code>.</li>
        <li>Quit Ollama (right-click its taskbar icon) and start it again from the Start menu.</li>
        <li>Press <strong>Check connection</strong>. If Chrome asks to let this site use apps on this device, choose <strong>Allow</strong>.</li>
      </ol></details></section>`;
    return h;
  }
  async function checkAI() {
    if (!AI || (S.ai && S.ai.busy)) return;
    const inp = $('#aiUrl');
    const url = AI.clean(inp ? inp.value : AI.config().url);
    if (!url) { S.ai = { err: { code: 'bad_address' } }; render(); return; }
    if (url !== AI.config().url) AI.save({ url, ready: false });
    const field = $('#aiModel');
    const want = (field && field.value.trim()) || AI.config().model;
    S.ai = { busy: true };
    render();
    try {
      const r = await AI.check(url);
      const tag = (n) => (n.includes(':') ? n : n + ':latest');
      const names = r.models.map((m) => m.name);
      const pick = names.find((n) => want && tag(n) === tag(want)) || names.find((n) => n === AI.DEFAULT_MODEL) || names[0] || '';
      AI.save({ url, model: pick, ready: !!pick });
      S.ai = { ok: r, err: pick ? null : { code: 'no_models' }, note: want && pick && tag(want) !== tag(pick) ? want + " isn't installed, so it uses this one." : '' };
      if (pick) toast('Local AI ready. Analyze will use ' + pick + '.');
    } catch (e) {
      S.ai = { err: e || { code: 'ai_error' } };
    }
    render();
  }
  function aiFieldChanged(el) {
    if (el.id === 'anTask') pickAnTask(el.value);
    else if (el.id === 'aiUrl') {
      const u = AI.clean(el.value);
      if (!u) S.ai = { err: { code: 'bad_address' } };
      else {
        if (S.ai && S.ai.err && S.ai.err.code === 'bad_address') S.ai = null;
        if (u !== AI.config().url) { AI.save({ url: u, ready: false }); S.ai = null; }
        el.value = u;
      }
    } else AI.save({ model: el.value.trim() });
    // A text field left by clicking elsewhere: that click is still on its way,
    // and re-rendering now would swallow it. A select changes as it is picked.
    if (document.activeElement !== el) { if (el.tagName === 'SELECT') render(); return; }
    // a focused field holds back re-rendering; this change should show at once
    const id = el.id;
    el.blur();
    render();
    const again = $('#' + id);
    if (again) again.focus();
  }

  // ---------- boot ----------
  function boot() {
    let v = (location.hash || '').replace('#', '');
    if (!VIEWS.includes(v)) { try { v = localStorage.getItem('logbook.view') || 'today'; } catch (e) { v = 'today'; } }
    S.view = VIEWS.includes(v) ? v : 'today';
    bindStatic();
    recompute();
    render();
    renderPreview(true);
    if (SA) bootStandalone();
    const C = window.claude;
    if (!C || typeof C.use !== 'function') { S.offline = true; recompute(); render(); return; }
    C.use('db').then((db) => {
      S.db = db;
      if (db) subscribe(); else { S.offline = true; render(); }
    }).catch(() => { S.offline = true; render(); });
    C.use('mcp').then((m) => { S.mcp = m; if (S.view === 'setup') render(); }).catch(() => {});
    C.use('sample').then((s) => { S.sample = s; renderPreview(); }).catch(() => {});
    C.use('downloads').then((d) => { S.downloads = d; if (S.view === 'setup') render(); }).catch(() => {});
    setInterval(() => { if (!document.hidden) changed(); }, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) changed(); });
  }
  boot();
})();
