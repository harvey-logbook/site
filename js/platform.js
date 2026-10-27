// Harvey's Logbook, stand-alone edition. Stands in for the claude.ai page
// runtime: the page still asks window.claude.use('db' | 'mcp' | 'downloads'),
// and here the answers are this browser's own database (IndexedDB), Google
// Calendar over its REST API, and a plain file download. It also syncs the
// database through a hidden app folder in Google Drive (see synccore.js).
(function () {
  'use strict';
  const SC = window.SyncCore;
  const CFG = Object.assign({ googleClientId: '' }, window.LOGBOOK_CONFIG || {});
  const CLIENT_ID = String(CFG.googleClientId || '').trim();
  const CONFIGURED = /^[\w-]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID);
  const DB_NAME = 'harveys-logbook';
  const SCOPE = {
    events: 'https://www.googleapis.com/auth/calendar.events',
    calendars: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    drive: 'https://www.googleapis.com/auth/drive.appdata',
  };
  const SCOPES = [SCOPE.events, SCOPE.calendars, SCOPE.drive];
  const CAL = 'https://www.googleapis.com/calendar/v3';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const TOKEN_KEY = 'logbook.google';

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function freeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) freeze(v[k]); }
    return v;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const later = (fn) => setTimeout(fn, 0);
  const rethrowLater = (e) => setTimeout(() => { throw e; }, 0);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  // Write times only move forward, even across devices whose clocks differ a little.
  let clock = 0;
  const tick = () => (clock = Math.max(Date.now(), clock + 1));
  const saw = (t) => { if (t > clock) clock = t; };

  // ---------- this device's database ----------
  const mem = new Map(); // path -> record
  const byCol = new Map(); // collection -> Map(path -> record)
  let idb = null;
  let persistent = true;
  let meta = { account: null, files: {}, lastSync: null };

  function setRec(r) {
    mem.set(r.path, r);
    let m = byCol.get(r.col);
    if (!m) byCol.set(r.col, (m = new Map()));
    m.set(r.path, r);
  }
  function storeErr(e) {
    const name = e && (e.name || (e.error && e.error.name));
    if (name === 'QuotaExceededError') return { code: 'quota_exceeded', message: "This device's storage is full." };
    return { code: 'unavailable', message: String((e && e.message) || e || 'storage error') };
  }
  function openIdb() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = () => { const d = req.result; d.onversionchange = () => { d.close(); idb = null; }; resolve(d); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Storage is blocked by another copy of this app. Close other tabs.'));
    });
  }
  function idbReq(store, fn) {
    return new Promise((resolve, reject) => {
      const r = fn(idb.transaction(store).objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function idbWrite(recs, withMeta) {
    if (!idb || (!recs.length && !withMeta)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(['docs', 'meta'], 'readwrite');
      const st = tx.objectStore('docs');
      for (const r of recs) st.put(r);
      if (withMeta) tx.objectStore('meta').put(clone(meta), 'sync');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  }
  async function reloadMeta() {
    if (!idb) return;
    const m = await idbReq('meta', (s) => s.get('sync'));
    if (m) meta = Object.assign({ account: null, files: {}, lastSync: null }, m);
  }
  function saveMeta() { return idbWrite([], true).catch(() => {}).then(() => broadcast({ type: 'meta' })); }

  const ready = (async () => {
    try {
      idb = await openIdb();
      const recs = await idbReq('docs', (s) => s.getAll());
      for (const r of recs || []) if (r && r.path && SC.splitPath(r.path)) { freeze(r.data); setRec(r); saw(r.t); }
      await reloadMeta();
    } catch (e) {
      console.warn('Logbook: on-device storage unavailable, nothing will be kept', e);
      idb = null;
      persistent = false;
    }
  })();

  // ---------- snapshots and queries (same shapes as the claude.ai store) ----------
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  const snaps = new WeakMap(); // body -> snapshot, so an unchanged document is the same object
  function docSnap(id, rec) {
    if (!rec || rec.del) return Object.freeze({ id, exists: false, data: () => undefined, metadata: META });
    let s = snaps.get(rec.data);
    if (!s) { const d = rec.data; s = Object.freeze({ id, exists: true, data: () => d, metadata: META }); snaps.set(d, s); }
    return s;
  }
  const typeRank = (v) => (v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : typeof v === 'string' ? 3 : 4);
  function cmp(a, b) {
    const ta = typeRank(a), tb = typeRank(b);
    if (ta !== tb) return ta - tb;
    if (ta === 4) { a = SC.stable(a); b = SC.stable(b); }
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const eq = (a, b) => a === b || (typeRank(a) === 4 && typeRank(b) === 4 && SC.stable(a) === SC.stable(b));
  const range = (test) => (a, b) => typeRank(a) === typeRank(b) && test(cmp(a, b));
  const OPS = {
    '==': eq,
    '!=': (a, b) => !eq(a, b),
    '<': range((c) => c < 0), '<=': range((c) => c <= 0), '>': range((c) => c > 0), '>=': range((c) => c >= 0),
    in: (a, b) => Array.isArray(b) && b.some((x) => eq(a, x)),
    'not-in': (a, b) => Array.isArray(b) && !b.some((x) => eq(a, x)),
    'array-contains': (a, b) => Array.isArray(a) && a.some((x) => eq(x, b)),
  };
  const has = (o, f) => Object.prototype.hasOwnProperty.call(o, f) && o[f] !== undefined;
  const idCmp = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  function runQuery(col, q) {
    const m = byCol.get(col);
    let recs = m ? Array.from(m.values()).filter((r) => !r.del) : [];
    for (const [f, op, v] of q.where) recs = recs.filter((r) => has(r.data, f) && OPS[op](r.data[f], v));
    if (q.orderBy) {
      const f = q.orderBy, dir = q.dir === 'desc' ? -1 : 1;
      recs.sort((a, b) => {
        const ha = has(a.data, f), hb = has(b.data, f);
        if (!ha || !hb) return ha === hb ? idCmp(a, b) : ha ? -1 : 1; // missing the field: last
        return cmp(a.data[f], b.data[f]) * dir || idCmp(a, b);
      });
    } else recs.sort(idCmp);
    return q.limit ? recs.slice(0, q.limit) : recs;
  }
  function changesFn(prev, docs) {
    return () => {
      const out = [];
      const before = new Map(prev.map((d, i) => [d.id, i]));
      const after = new Map(docs.map((d, i) => [d.id, i]));
      prev.forEach((d, i) => { if (!after.has(d.id)) out.push({ type: 'removed', doc: d, oldIndex: i, newIndex: -1 }); });
      docs.forEach((d, i) => {
        if (!before.has(d.id)) out.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i });
        else if (prev[before.get(d.id)] !== d) out.push({ type: 'modified', doc: d, oldIndex: before.get(d.id), newIndex: i });
      });
      return out;
    };
  }
  const querySnap = (docs, prev) => ({ docs, size: docs.length, empty: !docs.length, metadata: META, docChanges: changesFn(prev || [], docs) });

  // ---------- live listeners ----------
  const subs = new Set();
  let changedPaths = null;
  function changed(paths) {
    if (!paths.length) return;
    if (!changedPaths) { changedPaths = new Set(); later(flush); }
    for (const p of paths) changedPaths.add(p);
  }
  function flush() {
    const paths = changedPaths;
    changedPaths = null;
    const cols = new Set(Array.from(paths, (p) => p.split('/')[0]));
    for (const s of Array.from(subs)) if (s.kind === 'doc' ? paths.has(s.path) : cols.has(s.col)) deliver(s, false);
  }
  function deliver(s, first) {
    if (s.dead) return;
    try {
      if (s.kind === 'doc') {
        const snap = docSnap(s.id, mem.get(s.path));
        if (!first && s.last && s.last.exists === snap.exists && (!snap.exists || s.last === snap)) return;
        s.last = snap;
        s.next(snap);
      } else {
        const docs = runQuery(s.col, s.q).map((r) => docSnap(r.id, r));
        if (!first && s.docs && s.docs.length === docs.length && s.docs.every((d, i) => d === docs[i])) return;
        const prev = s.docs;
        s.docs = docs;
        s.next(querySnap(docs, prev));
      }
    } catch (e) { rethrowLater(e); }
  }
  function listen(s, next, error) {
    s.next = typeof next === 'function' ? next : () => {};
    s.error = error;
    subs.add(s);
    ready.then(() => later(() => deliver(s, true)));
    return () => { s.dead = true; subs.delete(s); };
  }

  // ---------- writes ----------
  const rewriteShards = new Set(); // shards still holding an old copy of a document that moved
  async function write(pairs) {
    await ready;
    const recs = [], prevs = [];
    for (const [path, data] of pairs) {
      const [col, id] = SC.splitPath(path);
      const prev = mem.get(path);
      const del = data === null;
      const s = del ? (prev && prev.s) || SC.shardOf(col, id, {}) : SC.shardOf(col, id, data);
      const rec = { path, col, id, data: del ? null : freeze(clone(data)), t: tick(), del, s, u: true };
      if (prev && prev.s !== s) rewriteShards.add(prev.s);
      prevs.push([path, prev]);
      setRec(rec);
      recs.push(rec);
    }
    changed(recs.map((r) => r.path));
    emitSoon();
    try {
      await idbWrite(recs);
    } catch (e) {
      // put memory back as it was, so the page shows what is really saved
      for (const [path, prev] of prevs) {
        if (prev) setRec(prev);
        else { mem.delete(path); const m = byCol.get(path.split('/')[0]); if (m) m.delete(path); }
      }
      changed(prevs.map(([p]) => p));
      throw storeErr(e);
    }
    broadcast({ type: 'recs', recs });
    autoSyncSoon();
  }
  function docRef(path) {
    const parts = SC.splitPath(path);
    if (!parts) throw { code: 'invalid_argument', message: 'Bad document path: ' + path };
    const [col, id] = parts;
    return Object.freeze({
      id, path,
      get: async () => { await ready; return docSnap(id, mem.get(path)); },
      set: async (data) => {
        if (!SC.isPlain(data)) throw { code: 'invalid_argument', message: 'set() needs an object' };
        return write([[path, data]]);
      },
      update: async (patch) => {
        await ready;
        if (!SC.isPlain(patch)) throw { code: 'invalid_argument', message: 'update() needs an object' };
        const cur = mem.get(path);
        if (!cur || cur.del) throw { code: 'invalid_argument', message: 'No document to update at ' + path };
        return write([[path, SC.deepMerge(cur.data, clone(patch))]]);
      },
      delete: async () => {
        await ready;
        const cur = mem.get(path);
        if (cur && !cur.del) return write([[path, null]]);
      },
      onSnapshot: (next, error) => listen({ kind: 'doc', path, id, col }, next, error),
      collection: () => { throw { code: 'invalid_argument', message: 'Nested collections are not used here' }; },
    });
  }
  function makeQuery(col, q) {
    const withQ = (patch) => makeQuery(col, Object.assign({}, q, patch));
    return {
      where: (f, op, v) => {
        if (!OPS[op]) throw { code: 'invalid_argument', message: 'Unknown operator ' + op };
        return withQ({ where: q.where.concat([[String(f), op, v]]) });
      },
      orderBy: (f, dir) => withQ({ orderBy: String(f), dir: dir === 'desc' ? 'desc' : 'asc' }),
      limit: (n) => {
        if (!(Number.isInteger(n) && n >= 1 && n <= 1000)) throw { code: 'invalid_argument', message: 'limit must be 1 to 1000' };
        return withQ({ limit: n });
      },
      get: async () => { await ready; return querySnap(runQuery(col, q).map((r) => docSnap(r.id, r))); },
      onSnapshot: (next, error) => listen({ kind: 'col', col, q }, next, error),
    };
  }
  function colRef(col) {
    if (!SC.splitPath(col + '/x')) throw { code: 'invalid_argument', message: 'Bad collection: ' + col };
    return Object.freeze(Object.assign(makeQuery(col, { where: [] }), {
      path: col,
      doc: (id) => docRef(col + '/' + (id || newId())),
      add: async (data) => { const r = docRef(col + '/' + newId()); await r.set(data); return r; },
    }));
  }
  const dbApi = Object.freeze({ doc: docRef, collection: colRef });

  // ---------- other tabs of this app ----------
  let bc = null;
  try { bc = new BroadcastChannel(DB_NAME); } catch (e) { bc = null; }
  function broadcast(msg) { if (bc) try { bc.postMessage(msg); } catch (e) { /* closed */ } }
  if (bc) bc.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'recs') {
      const paths = [];
      for (const r of m.recs || []) {
        const cur = mem.get(r.path);
        if (cur && r.t === cur.t) { if (cur.u !== r.u) setRec(Object.assign({}, cur, { u: r.u })); continue; }
        if (cur && r.t < cur.t) continue;
        freeze(r.data);
        setRec(r);
        saw(r.t);
        paths.push(r.path);
      }
      changed(paths);
      emitSoon();
    } else if (m.type === 'meta') reloadMeta().then(emitSoon, () => {});
  };

  // ---------- Google sign-in (Google Identity Services token flow) ----------
  let memToken = null;
  function tokenNow() {
    let t = memToken;
    try { const s = localStorage.getItem(TOKEN_KEY); t = s ? JSON.parse(s) : null; } catch (e) { /* storage blocked: keep the in-memory copy */ }
    return t && t.access_token && t.exp - Date.now() > 60 * 1000 ? t : null;
  }
  function saveToken(t) {
    memToken = t;
    try { if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* in memory only */ }
    emitSoon();
  }
  let gisP = null;
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisP) return gisP;
    gisP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisP = null; reject({ code: 'server_unavailable', retryable: true, message: "Couldn't load Google sign-in. Check the connection." }); };
      document.head.appendChild(s);
    });
    return gisP;
  }
  let tokenClient = null, gisWait = null, tokenP = null;
  async function signIn() {
    await loadGis();
    const o2 = google.accounts.oauth2;
    const resp = await new Promise((resolve, reject) => {
      gisWait = { resolve, reject };
      if (!tokenClient) {
        tokenClient = o2.initTokenClient({
          client_id: CLIENT_ID, scope: SCOPES.join(' '), include_granted_scopes: true,
          callback: (r) => gisWait && gisWait.resolve(r),
          error_callback: (e) => gisWait && gisWait.reject(e),
        });
      }
      // first time on this device: let him pick the account; after that, go straight to it
      tokenClient.requestAccessToken(meta.account ? { prompt: '', login_hint: meta.account } : { prompt: 'select_account' });
    }).catch((e) => {
      if (e && e.code) throw e;
      const type = e && e.type;
      throw type === 'popup_failed_to_open'
        ? { code: 'popup_blocked', message: 'The browser blocked the Google sign-in window.' }
        : { code: 'needs_reauth', message: type === 'popup_closed' ? 'Google sign-in was closed before it finished.' : (e && e.message) || 'Google sign-in failed.' };
    });
    if (!resp || resp.error || !resp.access_token) {
      throw { code: resp && resp.error === 'access_denied' ? 'not_granted' : 'needs_reauth', message: (resp && (resp.error_description || resp.error)) || 'Google sign-in failed.' };
    }
    const t = {
      access_token: resp.access_token,
      exp: Date.now() + (Number(resp.expires_in) || 3599) * 1000,
      scopes: SCOPES.filter((s) => o2.hasGrantedAllScopes(resp, s)),
      email: null,
    };
    t.email = await whoAmI(t);
    if (meta.account && t.email && t.email.toLowerCase() !== meta.account.toLowerCase()) {
      try { o2.revoke(t.access_token, () => {}); } catch (e) { /* ignore */ }
      throw { code: 'wrong_account', message: 'You signed in as ' + t.email + ', but this device syncs with ' + meta.account + '. Sign in as ' + meta.account + ', or sign out in Setup to switch accounts.' };
    }
    saveToken(t);
    return t;
  }
  async function whoAmI(t) {
    if (t.scopes.includes(SCOPE.drive)) {
      try { const r = await gfetch(t.access_token, DRIVE + '/about?fields=user(emailAddress)'); if (r.user && r.user.emailAddress) return r.user.emailAddress; } catch (e) { /* try the calendar */ }
    }
    if (t.scopes.includes(SCOPE.calendars)) {
      try { const r = await gfetch(t.access_token, CAL + '/users/me/calendarList/primary'); if (r.id) return r.id; } catch (e) { /* unknown */ }
    }
    return null;
  }
  // A token for `need`. Without a valid one, sign-in opens Google's window, which
  // browsers only allow straight after a tap, so background calls just fail.
  async function getToken(o) {
    o = o || {};
    if (!CONFIGURED) throw { code: 'not_configured', message: 'Google sign-in is not set up in this copy of the app.' };
    const t = tokenNow();
    if (t && (!o.need || t.scopes.includes(o.need))) return t;
    if (!tokenP) {
      // a background sync never opens the window, even just after an unrelated tap
      const tapped = o.interactive === true || (o.interactive !== false && !!(navigator.userActivation && navigator.userActivation.isActive));
      if (!tapped) throw t ? { code: 'not_granted', message: "Google didn't give the Logbook access to this." } : { code: 'needs_reauth', message: 'Signed out of Google.' };
      tokenP = signIn().finally(() => { tokenP = null; });
    }
    const nt = await tokenP;
    if (o.need && !nt.scopes.includes(o.need)) {
      throw { code: 'not_granted', message: o.need === SCOPE.drive ? "Google didn't give the Logbook its Drive app folder, so sync can't run." : "Google didn't give the Logbook calendar access." };
    }
    return nt;
  }
  async function signOut() {
    const t = tokenNow();
    if (t && window.google && google.accounts && google.accounts.oauth2) { try { google.accounts.oauth2.revoke(t.access_token, () => {}); } catch (e) { /* ignore */ } }
    saveToken(null);
    meta = Object.assign({}, meta, { account: null, files: {}, lastSync: null });
    status.error = null;
    await saveMeta();
    emitSoon();
  }

  // ---------- Google REST calls ----------
  async function gfetch(token, url, o) {
    o = o || {};
    const headers = Object.assign({ Authorization: 'Bearer ' + token }, o.headers || {});
    let body = o.body;
    if (o.json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json); }
    let res;
    try { res = await fetch(url, { method: o.method || 'GET', headers, body, cache: 'no-store' }); }
    catch (e) {
      throw navigator.onLine === false
        ? { code: 'offline', message: "You're offline." }
        : { code: 'server_unavailable', retryable: true, message: "Couldn't reach Google." };
    }
    if (res.status === 204) return {};
    const text = await res.text();
    if (res.ok) {
      if (o.raw) return text;
      try { return text ? JSON.parse(text) : {}; } catch (e) { throw { code: 'tool_error', message: 'Google sent an unreadable reply.' }; }
    }
    let err = {};
    try { err = (JSON.parse(text) || {}).error || {}; } catch (e) { /* not JSON */ }
    const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.status || '';
    const message = String(err.message || 'HTTP ' + res.status).slice(0, 300);
    if (res.status === 401) { saveToken(null); throw { code: 'needs_reauth', status: 401, message }; }
    if (res.status === 429 || res.status >= 500 || /rateLimitExceeded|userRateLimitExceeded/.test(reason)) {
      throw { code: 'upstream_error', status: res.status, retryable: true, retryAfterMs: (Number(res.headers.get('Retry-After')) || 1.5) * 1000, message };
    }
    if (res.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED/i.test(reason + ' ' + message)) throw { code: 'not_granted', status: 403, message };
    throw { code: 'tool_error', status: res.status, message };
  }
  async function retry(fn) {
    for (let i = 0; ; i++) {
      try { return await fn(); }
      catch (e) {
        if (!(e && e.retryable) || i >= 2) throw e;
        await sleep(Math.min(e.retryAfterMs || 700, 5000) * (i + 1) + Math.random() * 300);
      }
    }
  }

  // ---------- Google Calendar, answering the page's connector calls ----------
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London'; } catch (e) { return 'Europe/London'; } };
  function isoLocal(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s || ''));
    if (!m) return new Date(s).toISOString();
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).toISOString();
  }
  const calPath = (id) => CAL + '/calendars/' + encodeURIComponent(id || 'primary');
  async function pages(tk, url, key, max) {
    let items = [], token = null, n = 0;
    do {
      const r = await gfetch(tk, url + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      items = items.concat(r[key] || []);
      token = r.nextPageToken;
    } while (token && ++n < max);
    return items;
  }
  const CAL_TOOLS = {
    async list_events(i, tk) {
      const p = new URLSearchParams({ timeMin: isoLocal(i.startTime), timeMax: isoLocal(i.endTime), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(250, Number(i.pageSize) || 100)) });
      return { events: await pages(tk, calPath(i.calendarId) + '/events?' + p, 'items', 5) };
    },
    async create_event(i, tk) {
      const zone = tz();
      const body = {
        summary: i.summary, description: i.description,
        start: { dateTime: i.startTime, timeZone: zone }, end: { dateTime: i.endTime, timeZone: zone },
        transparency: i.availability === 'AVAILABILITY_FREE' ? 'transparent' : 'opaque',
      };
      if (i.colorId) body.colorId = String(i.colorId);
      if (i.useDefaultReminders === false) body.reminders = { useDefault: false, overrides: [] };
      return gfetch(tk, calPath(i.calendarId) + '/events', { method: 'POST', json: body });
    },
    async delete_event(i, tk) {
      try { await gfetch(tk, calPath(i.calendarId) + '/events/' + encodeURIComponent(i.eventId) + '?sendUpdates=none', { method: 'DELETE' }); }
      catch (e) { if (e && (e.status === 404 || e.status === 410)) return {}; throw e; }
      return {};
    },
    async list_calendars(i, tk) {
      const items = await pages(tk, CAL + '/users/me/calendarList?maxResults=250', 'items', 5);
      return { calendars: items.map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary, primary: !!c.primary, accessRole: c.accessRole })) };
    },
  };
  const mcpApi = Object.freeze({
    async callTool(server, tool, input) {
      if (server !== 'Google Calendar' || !CAL_TOOLS[tool]) throw { code: 'not_in_manifest', message: server + ' ' + tool };
      const t = await getToken({ need: tool === 'list_calendars' ? SCOPE.calendars : SCOPE.events });
      return { content: [], payload: await CAL_TOOLS[tool](input || {}, t.access_token) };
    },
  });

  // ---------- file downloads ----------
  const downloadsApi = Object.freeze({
    async save(o) {
      const type = /\.csv$/i.test(o.filename || '') ? 'text/csv' : 'application/json';
      const blob = new Blob([o.data], { type: type + ';charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = o.filename || 'logbook.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return { status: 'saved' };
    },
  });

  // ---------- sync through Google Drive's hidden app folder ----------
  const status = { syncing: false, error: null };
  let syncing = null, again = false, autoT = null;
  async function driveList(tk) {
    const p = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,version,createdTime,modifiedTime)', pageSize: '1000' });
    return pages(tk, DRIVE + '/files?' + p, 'files', 20);
  }
  const driveDownload = (tk, id) => gfetch(tk, DRIVE + '/files/' + encodeURIComponent(id) + '?alt=media', { raw: true });
  function driveCreate(tk, name, text) {
    const b = 'logbook' + newId();
    const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' }) +
      '\r\n--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + text + '\r\n--' + b + '--';
    return gfetch(tk, UPLOAD + '/files?uploadType=multipart&fields=id,name,version,createdTime', { method: 'POST', body, headers: { 'Content-Type': 'multipart/related; boundary=' + b } });
  }
  const driveUpdate = (tk, id, text) => gfetch(tk, UPLOAD + '/files/' + encodeURIComponent(id) + '?uploadType=media&fields=id,name,version', { method: 'PATCH', body: text, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
  const driveDelete = (tk, id) => gfetch(tk, DRIVE + '/files/' + encodeURIComponent(id), { method: 'DELETE' });
  async function applyMerge(m) {
    const out = [], paths = [];
    for (const c of m.apply) {
      c.data = c.del ? null : freeze(clone(c.data));
      setRec(c);
      saw(c.t);
      out.push(c);
      paths.push(c.path);
    }
    for (const p of m.reupload) {
      const cur = mem.get(p);
      if (cur && !cur.u) { const n = Object.assign({}, cur, { u: true }); setRec(n); out.push(n); }
    }
    if (out.length) { await idbWrite(out); broadcast({ type: 'recs', recs: out }); }
    changed(paths);
    return paths.length;
  }
  async function markSynced(recs) {
    const out = [];
    for (const r of recs) {
      const cur = mem.get(r.path);
      if (cur && cur.u && cur.t === r.t) { const n = Object.assign({}, cur, { u: false }); setRec(n); out.push(n); }
    }
    if (out.length) { await idbWrite(out).catch(() => {}); broadcast({ type: 'recs', recs: out }); }
    return out.length;
  }
  async function syncRound(tk) {
    const r = await SC.syncPass({
      list: () => retry(() => driveList(tk)),
      download: (id) => retry(() => driveDownload(tk, id)),
      create: (name, text) => retry(() => driveCreate(tk, name, text)),
      update: (id, text) => retry(() => driveUpdate(tk, id, text)),
      remove: (id) => driveDelete(tk, id),
      records: () => mem.values(),
      apply: applyMerge,
      synced: markSynced,
    }, meta.files, rewriteShards);
    for (const s of r.written) rewriteShards.delete(s);
    meta.files = r.known;
    return { pulled: r.pulled, pushed: r.pushed };
  }
  function withLock(fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request('harveys-logbook-sync', fn);
    return fn();
  }
  function sync(o) {
    o = o || {};
    if (!CONFIGURED) return Promise.reject({ code: 'not_configured', message: 'Google sign-in is not set up in this copy of the app.' });
    if (syncing) { again = true; return syncing; }
    status.syncing = true;
    emitSoon();
    syncing = (async () => {
      try {
        await ready;
        const t = await getToken({ interactive: o.interactive, need: SCOPE.drive });
        const r = await withLock(async () => {
          await reloadMeta();
          if (t.email && meta.account && t.email.toLowerCase() !== meta.account.toLowerCase()) {
            throw { code: 'wrong_account', message: 'You signed in as ' + t.email + ', but this device syncs with ' + meta.account + '. Sign out in Setup to switch accounts.' };
          }
          if (t.email && !meta.account) meta.account = t.email;
          const res = await syncRound(t.access_token);
          meta.lastSync = Date.now();
          await saveMeta();
          return res;
        });
        status.error = null;
        return r;
      } catch (e) {
        // a lapsed sign-in during background sync is normal: the chip asks for a tap instead
        status.error = e && e.code === 'needs_reauth' && o.interactive !== true ? null : { code: (e && e.code) || 'unknown', message: String((e && e.message) || e || '').slice(0, 300) };
        throw e;
      } finally {
        status.syncing = false;
        syncing = null;
        emitSoon();
        if (again) { again = false; autoSyncSoon(500); }
      }
    })();
    return syncing;
  }
  function autoSyncSoon(ms) {
    if (!CONFIGURED) return;
    if (syncing) { again = true; return; }
    clearTimeout(autoT);
    autoT = setTimeout(() => { if (tokenNow() && navigator.onLine !== false) sync({ interactive: false }).catch(() => {}); }, ms == null ? 3000 : ms);
  }
  function askPersist() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {}); } catch (e) { /* not offered */ }
  }

  // ---------- status for the page ----------
  const statusFns = new Set();
  let emitT = null;
  function getStatus() {
    let pending = 0, empty = true;
    for (const r of mem.values()) { if (r.u) pending++; if (!r.del) empty = false; }
    const t = tokenNow();
    return {
      configured: CONFIGURED, syncing: status.syncing, signedIn: !!t, account: meta.account || (t && t.email) || null,
      lastSync: meta.lastSync || null, pending, error: status.error, online: navigator.onLine !== false,
      everSynced: !!meta.lastSync, persistent, update: !!swWaiting, empty,
    };
  }
  function emitSoon() {
    if (emitT) return;
    emitT = setTimeout(() => {
      emitT = null;
      const st = getStatus();
      for (const fn of Array.from(statusFns)) { try { fn(st); } catch (e) { rethrowLater(e); } }
    }, 30);
  }

  // ---------- import ----------
  function readImport(text) {
    const ex = SC.readExport(text);
    return Object.assign({ exportedAt: ex.exportedAt, counts: ex.counts, skipped: ex.skipped.length, docs: ex.docs }, SC.planImport(ex.docs, mem));
  }
  async function applyImport(plan) {
    await ready;
    const pairs = plan.docs
      .filter((d) => { const l = mem.get(d.path); return !l || l.del || SC.stable(l.data) !== SC.stable(d.data); })
      .map((d) => [d.path, d.data]);
    if (pairs.length) await write(pairs);
    askPersist();
    return pairs.length;
  }

  // ---------- offline copy and updates (service worker) ----------
  let swReg = null, swWaiting = null, swUpdating = false, swChecked = Date.now();
  function setupSW() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      swReg = reg;
      const check = () => { if (reg.waiting && navigator.serviceWorker.controller) { swWaiting = reg.waiting; emitSoon(); } };
      check();
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') check(); });
      });
    }).catch((e) => console.warn('Logbook: offline copy unavailable', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (swUpdating) location.reload(); });
  }
  function applyUpdate() {
    if (swWaiting) { swUpdating = true; swWaiting.postMessage('skipWaiting'); } else location.reload();
  }

  // ---------- wiring ----------
  window.LOGBOOK_STANDALONE = true;
  const caps = {
    db: () => ready.then(() => dbApi),
    mcp: () => (CONFIGURED ? mcpApi : null),
    downloads: () => downloadsApi,
  };
  window.claude = Object.freeze({ use: (name) => new Promise((r) => later(r)).then(() => (caps[name] ? caps[name]() : null)) });
  window.LogbookPlatform = Object.freeze({
    status: getStatus,
    onStatus: (fn) => { statusFns.add(fn); return () => statusFns.delete(fn); },
    sync: (o) => { askPersist(); return sync(Object.assign({ interactive: true }, o)); },
    signOut, readImport, applyImport, applyUpdate,
  });

  if (CONFIGURED) loadGis().catch(() => {});
  ready.then(() => { emitSoon(); if (tokenNow()) autoSyncSoon(300); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    emitSoon();
    if (tokenNow() && (!meta.lastSync || Date.now() - meta.lastSync > 45 * 1000)) autoSyncSoon(200);
    if (swReg && Date.now() - swChecked > 30 * 60 * 1000) { swChecked = Date.now(); swReg.update().catch(() => {}); }
  });
  setInterval(() => { if (!document.hidden && tokenNow()) autoSyncSoon(0); }, 5 * 60 * 1000);
  window.addEventListener('online', () => { emitSoon(); autoSyncSoon(500); });
  window.addEventListener('offline', emitSoon);
  window.addEventListener('storage', (e) => { if (e.key === TOKEN_KEY) emitSoon(); });
  if (document.readyState === 'complete') setupSW(); else window.addEventListener('load', setupSW);
})();
