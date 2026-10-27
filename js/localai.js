// The Analyze tab's AI: a model running on Harvey's own laptop through Ollama
// (https://ollama.com). The app sends it one task's facts, and only when he
// presses Ask the AI. Settings are kept per device (localStorage), because a
// phone can't reach the laptop's localhost.
(function (root) {
  'use strict';
  const KEY = 'logbook.ai';
  const DEFAULT_URL = 'http://localhost:11434';
  const DEFAULT_MODEL = 'qwen3.5:4b';

  // The page's Content Security Policy (build.js) lets it reach this computer,
  // or another of Harvey's machines through a Tailscale HTTPS name, and nothing else.
  function clean(u) {
    u = String(u || '').trim();
    if (!u) return null;
    if (!/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
    let x;
    try { x = new URL(u); } catch (e) { return null; }
    if (x.username || x.password || x.search || x.hash || (x.pathname && x.pathname !== '/')) return null;
    const local = /^(localhost|127\.0\.0\.1)$/.test(x.hostname);
    if (local && (x.protocol === 'http:' || x.protocol === 'https:')) return x.origin;
    if (x.protocol === 'https:' && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(x.hostname)) return x.origin;
    return null;
  }

  function load() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(KEY)); } catch (e) { c = null; }
    c = c && typeof c === 'object' ? c : {};
    return { url: clean(c.url) || DEFAULT_URL, model: typeof c.model === 'string' ? c.model : '', ready: c.ready === true };
  }
  let cur = load();
  const config = () => Object.assign({}, cur);
  function save(patch) {
    cur = Object.assign({}, cur, patch);
    try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (e) { /* storage off: kept for this visit */ }
    return config();
  }
  // another tab of the app changed the settings
  try { addEventListener('storage', (e) => { if (e.key === KEY) cur = load(); }); } catch (e) { /* not a page */ }

  // A failed fetch can mean "not running" or "running but refusing this site"
  // (Ollama's allowed origins). An opaque no-cors request still reaches a
  // running server, so it tells the two apart.
  async function diagnose(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      await fetch(url + '/', { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
      return { code: 'blocked', url };
    } catch (e) {
      return { code: 'unreachable', url };
    } finally {
      clearTimeout(timer);
    }
  }
  async function req(url, path, init, signal) {
    let res;
    try { res = await fetch(url + path, Object.assign({ cache: 'no-store', signal }, init || {})); }
    catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'aborted' };
      throw await diagnose(url);
    }
    if (res.ok) return res;
    let msg = '';
    try { const j = await res.json(); msg = (j && j.error) || ''; } catch (e) { /* not JSON */ }
    msg = String(msg || res.statusText || 'HTTP ' + res.status).slice(0, 300);
    // Ollama answers 403 to a site missing from OLLAMA_ORIGINS (when the browser lets the answer through at all)
    if (res.status === 403) throw { code: 'blocked', url, status: 403 };
    if (res.status === 404 && /not found/i.test(msg)) throw { code: 'model_missing', status: 404, message: msg };
    if (/does not support thinking/i.test(msg)) throw { code: 'no_thinking', status: res.status, message: msg };
    throw { code: 'ai_error', status: res.status, message: msg };
  }

  // Version and installed models: the Setup check.
  async function check(url) {
    let version = '';
    try { version = String(((await (await req(url, '/api/version')).json()) || {}).version || ''); }
    catch (e) { if (e && (e.code === 'unreachable' || e.code === 'blocked' || e.code === 'aborted')) throw e; }
    const tags = await (await req(url, '/api/tags')).json();
    const models = ((tags && tags.models) || [])
      .map((m) => ({ name: String(m.name || m.model || ''), size: Number(m.size) || 0, params: String((m.details && m.details.parameter_size) || '') }))
      .filter((m) => m.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { version, models };
  }

  // Streams one chat answer. o: {url, model, messages, signal, onText(text, thinking)}.
  // Thinking is turned off (it is slow on a laptop CPU); models without a
  // thinking mode reject the switch, so the request is sent again without it.
  async function chat(o) {
    const body = { model: o.model, messages: o.messages, stream: true, think: false, options: { temperature: 0.3 } };
    const send = () => req(o.url, '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, o.signal);
    const t0 = Date.now();
    let res;
    try { res = await send(); }
    catch (e) {
      if (!e || e.code !== 'no_thinking') throw e;
      delete body.think;
      res = await send();
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', end = null;
    const line = (s) => {
      if (!s.trim()) return;
      let j;
      try { j = JSON.parse(s); } catch (e) { return; }
      if (j.error) throw { code: 'ai_error', message: String(j.error).slice(0, 300) };
      const m = j.message || {};
      if (m.content) { text += m.content; if (o.onText) o.onText(text, false); }
      else if (m.thinking && !text && o.onText) o.onText('', true);
      if (j.done) end = j;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      line(buf + dec.decode());
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'aborted', text };
      if (e && e.code) throw Object.assign({ text }, e);
      throw { code: 'ai_error', message: 'The connection to the AI dropped.', text };
    }
    return { text: text.trim(), ms: Date.now() - t0, tokens: end && end.eval_count ? end.eval_count : null, complete: !!end };
  }

  root.LocalAI = { DEFAULT_URL, DEFAULT_MODEL, clean, config, save, check, chat };
})(typeof globalThis !== 'undefined' ? globalThis : this);
