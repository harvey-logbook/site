// Sync rules for the stand-alone Logbook. Every document is a record
// {path, col, id, data, t, del, s, u}: t is when it was last written (a
// clock that only moves forward), del marks a deletion, s is the Drive file
// ("shard") it lives in and u means this device has a change Drive hasn't
// got yet. Newest t wins per document. No browser APIs here, so node tests
// can run it.
(function (root) {
  'use strict';
  const FORMAT = 'harveys-logbook-shard';
  const EXPORT_FORMAT = 'harveys-logbook';
  const COL_RE = /^[a-z][a-z0-9_-]{0,40}$/i;
  const ID_RE = /^[^/\s][^/]{0,199}$/;

  // Logs and plans split by month, so a sync only moves the months that changed.
  function shardOf(col, id, data) {
    if (col === 'logs' || col === 'plans') {
      const d = String((data && data.date) || (col === 'plans' ? id : '') || '');
      return col + '-' + (/^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : 'undated');
    }
    return 'core';
  }
  const fileName = (shard) => 'logbook-' + shard + '.json';
  function shardFromName(name) {
    const m = /^logbook-([a-z0-9-]+)\.json$/.exec(name || '');
    return m ? m[1] : null;
  }
  function splitPath(path) {
    const parts = String(path).split('/');
    if (parts.length !== 2 || !COL_RE.test(parts[0]) || !ID_RE.test(parts[1])) return null;
    return parts;
  }

  // JSON with sorted keys: the same content always gives the same string.
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  // > 0 when a is the version to keep. Ties (same t) fall back to content, so
  // every device picks the same winner.
  function newer(a, b) {
    if (a.t !== b.t) return a.t > b.t ? 1 : -1;
    if (!!a.del !== !!b.del) return a.del ? 1 : -1;
    const sa = stable(a.data), sb = stable(b.data);
    return sa === sb ? 0 : sa > sb ? 1 : -1;
  }

  function buildShard(shard, recs) {
    const records = {};
    for (const r of recs.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      records[r.path] = r.del ? { t: r.t, deleted: true } : { t: r.t, data: r.data };
    }
    return { format: FORMAT, version: 1, shard, records };
  }
  function parseShard(text, shard) {
    let j;
    try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw { code: 'bad_file', message: fileName(shard) + ' is not valid JSON' }; }
    if (!j || j.format !== FORMAT || typeof j.records !== 'object' || !j.records) throw { code: 'bad_file', message: fileName(shard) + ' is not a Logbook sync file' };
    if (j.version !== 1) throw { code: 'bad_file', message: fileName(shard) + ' comes from a newer version of the app. Reload to update.' };
    const records = {};
    for (const [path, r] of Object.entries(j.records)) {
      if (!splitPath(path) || !r || typeof r.t !== 'number' || !(r.t > 0)) continue;
      if (r.deleted) records[path] = { t: r.t, deleted: true };
      else if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) records[path] = { t: r.t, data: r.data };
    }
    return { shard: j.shard || shard, records };
  }

  // Folds one downloaded shard into this device's records.
  //   local: Map path -> record; inShard: this device's records whose s is shard.
  // Returns apply (newer versions from the file), reupload (paths whose local
  // version the file lacks or holds older) and rewrite (the file still holds
  // a copy of a record that now lives in another shard, so it should be
  // written again without it).
  function mergeShard(shard, remote, local, inShard) {
    const apply = [], reupload = [];
    let rewrite = false;
    for (const [path, r] of Object.entries(remote.records)) {
      const [col, id] = splitPath(path) || [];
      if (!col) continue;
      const del = !!r.deleted;
      const cand = { path, col, id, data: del ? null : r.data, t: r.t, del };
      const l = local.get(path);
      const cmp = l ? newer(cand, l) : 1;
      if (cmp > 0) {
        cand.s = del ? shard : shardOf(col, id, cand.data);
        cand.u = cand.s !== shard;
        if (cand.u) rewrite = true;
        apply.push(cand);
      } else if (cmp < 0) {
        if (l.s === shard) reupload.push(path); else rewrite = true;
      }
    }
    for (const l of inShard || []) if (!(l.path in remote.records) && !l.u) reupload.push(l.path);
    return { apply, reupload, rewrite };
  }

  // One sync pass against the file store (Google Drive's app folder in the app).
  //   io.list() -> [{id, name, version, createdTime}]; io.download(id) -> text
  //   io.create(name, text) / io.update(id, text) -> {id, version}; io.remove(id)
  //   io.records() -> this device's records; io.apply(merge) -> how many it applied
  //   io.synced(recs) -> how many it marked as synced
  // known: shard -> {id, version} as of this device's last pass; rewrite: shards
  // to write again even without new changes. Downloads only the files whose
  // version moved, folds them in, then uploads every shard this device has news
  // for. If another device writes in between, its next pass finds its changes
  // missing from the file and uploads them again, so both end up the same.
  async function syncPass(io, known, rewrite) {
    known = Object.assign({}, known || {});
    rewrite = new Set(rewrite || []);
    const inShard = (shard) => Array.from(io.records()).filter((r) => r.s === shard);
    const remote = new Map();
    for (const f of await io.list()) {
      const s = shardFromName(f.name);
      if (!s) continue;
      if (!remote.has(s)) remote.set(s, []);
      remote.get(s).push(f);
    }
    for (const list of remote.values()) list.sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const extra = [];
    let pulled = 0, pushed = 0;
    for (const [shard, list] of remote) {
      const keep = list[0];
      const k = known[shard];
      if (list.length === 1 && k && k.id === keep.id && k.version === String(keep.version)) continue;
      for (const f of list) {
        let text;
        try { text = await io.download(f.id); } catch (e) { if (e && e.status === 404) continue; throw e; }
        const m = mergeShard(shard, parseShard(text, shard), new Map(Array.from(io.records(), (r) => [r.path, r])), inShard(shard));
        pulled += await io.apply(m);
        if (m.rewrite) rewrite.add(shard);
      }
      // two devices both created this file: keep the oldest, fold the rest in and remove them
      if (list.length > 1) { rewrite.add(shard); extra.push(...list.slice(1)); }
      known[shard] = { id: keep.id, version: String(keep.version) };
    }
    for (const s of Object.keys(known)) if (!remote.has(s)) delete known[s];
    const dirty = new Set(rewrite);
    for (const r of io.records()) if (r.u || !remote.has(r.s)) dirty.add(r.s);
    const written = [];
    for (const shard of Array.from(dirty).sort()) {
      const recs = inShard(shard);
      const list = remote.get(shard);
      if (!recs.length && !list) continue;
      const body = JSON.stringify(buildShard(shard, recs));
      const res = list ? await io.update(list[0].id, body) : await io.create(fileName(shard), body);
      known[shard] = { id: res.id, version: String(res.version) };
      pushed += await io.synced(recs);
      written.push(shard);
    }
    for (const f of extra) { try { await io.remove(f.id); } catch (e) { /* already gone */ } }
    return { known, pulled, pushed, written };
  }

  // A full export from either app ("Export everything"): checks it and lists its documents.
  function readExport(text) {
    let j;
    try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw { code: 'bad_file', message: "That file isn't valid JSON." }; }
    if (!j || j.format !== EXPORT_FORMAT || !j.collections || typeof j.collections !== 'object') throw { code: 'bad_file', message: "That isn't a Logbook export. Use Setup › Your data › Export everything in the Logbook." };
    if (j.version !== 1) throw { code: 'bad_file', message: 'That export comes from a newer version of the Logbook. Reload this app to update it first.' };
    const docs = [], counts = {}, skipped = [];
    for (const [col, list] of Object.entries(j.collections)) {
      if (!COL_RE.test(col) || !Array.isArray(list)) { skipped.push(col); continue; }
      counts[col] = 0;
      for (const d of list) {
        if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID_RE.test(d.id)) { skipped.push(col + '/?'); continue; }
        const data = Object.assign({}, d);
        delete data.id;
        docs.push({ path: col + '/' + d.id, col, id: d.id, data });
        counts[col]++;
      }
    }
    return { exportedAt: j.exportedAt || null, counts, docs, skipped };
  }
  // How an import would change this device: added, updated, unchanged.
  function planImport(docs, local) {
    let add = 0, update = 0, same = 0;
    for (const d of docs) {
      const l = local.get(d.path);
      if (!l || l.del) add++;
      else if (stable(l.data) === stable(d.data)) same++;
      else update++;
    }
    return { add, update, same };
  }

  // set/update semantics of the claude.ai store: update merges plain objects
  // recursively; arrays and everything else replace.
  function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function deepMerge(base, patch) {
    const out = Object.assign({}, base);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || k === '__proto__') continue;
      out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v;
    }
    return out;
  }

  const api = { FORMAT, EXPORT_FORMAT, shardOf, fileName, shardFromName, splitPath, stable, newer, buildShard, parseShard, mergeShard, syncPass, readExport, planImport, deepMerge, isPlain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
