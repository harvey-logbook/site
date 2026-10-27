// Planner engine: estimate calibration, capacity, single-person schedule
// forecast and per-project critical paths. Plain JS, no dependencies, so the
// same file runs in the page and in Node for Claude's daily planning.
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  const Z80 = 0.8416; // standard normal quantile for P80

  // ---- dates (all dates are local 'YYYY-MM-DD' strings) ----
  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function fmtDate(dt) {
    return dt.toISOString().slice(0, 10);
  }
  function addDays(s, n) {
    return fmtDate(new Date(parseDate(s).getTime() + n * DAY_MS));
  }
  function weekday(s) {
    // 0 = Monday ... 6 = Sunday
    return (parseDate(s).getUTCDay() + 6) % 7;
  }
  function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
  }

  // ---- calibration ----
  // Learns how far actual hours run from estimates, per category, in log
  // space. Small samples shrink toward the overall figure, which itself
  // shrinks toward a prior (people usually underestimate), so early
  // multipliers stay sensible and sharpen as logs build up.
  const DEFAULT_PRIOR = { mu: Math.log(1.25), sigma: 0.5, weight: 5 };

  function calibrate(tasks, opts) {
    const o = Object.assign({ prior: DEFAULT_PRIOR, k: 5, minHours: 0.1 }, opts || {});
    const done = tasks.filter(
      (t) => t.status === 'done' && t.estimateH > 0 && (t.actualH || 0) >= o.minHours && isMine(t)
    );
    const logs = done.map((t) => ({ cat: t.category || 'other', r: Math.log(t.actualH / t.estimateH) }));

    const stats = (xs) => {
      const n = xs.length;
      if (!n) return { n: 0, mean: 0, variance: 0 };
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
      return { n, mean, variance };
    };

    const all = stats(logs.map((l) => l.r));
    const w = o.prior.weight;
    const gMu = (all.n * all.mean + w * o.prior.mu) / (all.n + w);
    const gVar = (Math.max(all.n - 1, 0) * all.variance + w * o.prior.sigma ** 2) / (Math.max(all.n - 1, 0) + w);
    const global = summarise('all', all.n, gMu, Math.sqrt(gVar), all.n ? Math.exp(all.mean) : null);

    const byCat = {};
    const cats = [...new Set(logs.map((l) => l.cat))];
    for (const c of cats) {
      const s = stats(logs.filter((l) => l.cat === c).map((l) => l.r));
      const mu = (s.n * s.mean + o.k * gMu) / (s.n + o.k);
      const v = (Math.max(s.n - 1, 0) * s.variance + o.k * gVar) / (Math.max(s.n - 1, 0) + o.k);
      byCat[c] = summarise(c, s.n, mu, Math.sqrt(v), Math.exp(s.mean));
    }
    return { global, byCat, sampleSize: all.n };
  }

  function summarise(cat, n, mu, sigma, rawMedian) {
    return {
      category: cat,
      n,
      p50: Math.exp(mu),
      p80: Math.exp(mu + Z80 * sigma),
      sigma,
      rawMedian, // the observed ratio before shrinkage (null with no data)
    };
  }

  function multiplier(cal, category, quantile) {
    const c = (cal.byCat && cal.byCat[category]) || cal.global;
    return quantile === 'p80' ? c.p80 : c.p50;
  }

  // ---- capacity ----
  // settings.weekHours: hours of project work per weekday, Monday first.
  // settings.overrides: {'YYYY-MM-DD': hours} for exam weeks, trips etc.
  // settings.factor: share of planned hours that actually happens (learned).
  function capacityFn(settings) {
    const s = Object.assign({ weekHours: [3, 3, 3, 3, 3, 5, 4], overrides: {}, factor: 1 }, settings || {});
    return (date) => {
      const base = date in s.overrides ? s.overrides[date] : s.weekHours[weekday(date)];
      return Math.max(0, base * s.factor);
    };
  }

  // Learned capacity factor: logged hours / planned capacity over past days
  // that had a plan. Returns null with fewer than minDays of evidence.
  function capacityFactor(logs, settings, fromDate, toDate, minDays) {
    const cap = capacityFn(Object.assign({}, settings, { factor: 1 }));
    let planned = 0, actual = 0, days = 0;
    const byDay = {};
    for (const l of logs) byDay[l.date] = (byDay[l.date] || 0) + l.minutes / 60;
    for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
      const c = cap(d);
      if (c <= 0) continue;
      planned += c;
      actual += byDay[d] || 0;
      days++;
    }
    if (days < (minDays || 7) || planned === 0) return null;
    return { factor: actual / planned, days, planned, actual };
  }

  // Cumulative work-hour timeline from `today`. H(date) = hours available
  // from now until the START of date. todayUsed = hours already logged today.
  function timeline(today, cap, horizonDays, todayUsed) {
    const starts = [0];
    const dates = [today];
    let acc = 0;
    for (let i = 0; i < horizonDays; i++) {
      const d = addDays(today, i);
      const c = i === 0 ? Math.max(0, cap(d) - (todayUsed || 0)) : cap(d);
      acc += c;
      dates.push(addDays(today, i + 1));
      starts.push(acc);
    }
    const H = (date) => {
      const i = daysBetween(today, date);
      if (i <= 0) return 0;
      if (i >= starts.length) return starts[starts.length - 1] + (i - starts.length + 1) * 1e-6; // beyond horizon
      return starts[i];
    };
    // Date on which work-hour h falls (the day whose capacity contains it).
    const dateAt = (h) => {
      if (!(h < starts[starts.length - 1])) return null; // beyond horizon
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= h) lo = mid; else hi = mid - 1;
      }
      // skip zero-capacity days so a finish never lands on a day off
      while (lo + 1 < starts.length && starts[lo + 1] === starts[lo]) lo++;
      return dates[lo];
    };
    // Finish time h belongs to the day where the cumulative total reaches h.
    const finishDateAt = (h) => {
      if (h <= 0) return today;
      if (!(h <= starts[starts.length - 1])) return null;
      let lo = 1, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] >= h - 1e-9) hi = mid; else lo = mid + 1;
      }
      return dates[lo - 1];
    };
    return { H, dateAt, finishDateAt, totalHours: starts[starts.length - 1] };
  }

  function isMine(t) {
    return !t.owner || t.owner === 'me';
  }

  // ---- forecast ----
  // Preemptive earliest-deadline-first over one person's hours, with
  // deadlines pushed back through dependencies first (each task inherits the
  // latest start of anything that waits on it). Tasks owned by teammates take
  // none of Harvey's hours; they finish on their expected date.
  function forecast(input) {
    const o = Object.assign({ quantile: 'p50', horizonDays: 240, todayUsed: 0 }, input);
    const { tasks, projects, today } = o;
    const cal = o.calibration || calibrate(tasks);
    const cap = capacityFn(o.settings);
    const tl = timeline(today, cap, o.horizonDays, o.todayUsed);
    const proj = Object.fromEntries((projects || []).map((p) => [p.id, p]));

    const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped');
    const byId = Object.fromEntries(open.map((t) => [t.id, t]));
    const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));

    // Projects with a weekly pace (e.g. 3 applications a week) give their
    // undated tasks soft deadlines in list order, so rolling goals still get
    // hours instead of waiting behind everything that has a date.
    const soft = {};
    for (const p of projects || []) {
      if (!p.pacePerWeek) continue;
      const undated = open
        .filter((t) => t.projectId === p.id && !t.deadline && isMine(t))
        .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (a.id < b.id ? -1 : 1));
      undated.forEach((t, k) => (soft[t.id] = addDays(today, Math.ceil(((k + 1) * 7) / p.pacePerWeek) - 1)));
    }

    const node = {};
    for (const t of open) {
      const mult = multiplier(cal, t.category || 'other', o.quantile);
      const est = (t.estimateH || 1) * mult;
      const logged = t.actualH || 0;
      const rem = isMine(t) ? Math.max(est - logged, Math.min(0.25, est)) : 0;
      const deadlines = [t.deadline, proj[t.projectId] && proj[t.projectId].deadline, soft[t.id]].filter(Boolean);
      const dl = deadlines.length ? deadlines.sort()[0] : null;
      node[t.id] = {
        t,
        rem,
        estCal: est,
        mult,
        preds: (t.dependsOn || []).filter((d) => byId[d]), // done deps impose nothing
        missingDeps: (t.dependsOn || []).filter((d) => !byId[d] && !doneIds.has(d)),
        succs: [],
        deadline: dl,
        soft: !!soft[t.id] && dl === soft[t.id],
        release: t.notBefore ? tl.H(t.notBefore) : 0,
        externalFinish: !isMine(t) ? (t.externalDue ? tl.H(addDays(t.externalDue, 1)) : 0) : null,
      };
    }
    for (const id in node) for (const p of node[id].preds) node[p].succs.push(id);

    // topological order (cycles are reported and broken)
    const order = [];
    const indeg = Object.fromEntries(Object.keys(node).map((id) => [id, node[id].preds.length]));
    const queue = Object.keys(node).filter((id) => indeg[id] === 0);
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const s of node[id].succs) if (--indeg[s] === 0) queue.push(s);
    }
    const cyclic = Object.keys(node).filter((id) => !order.includes(id));
    for (const id of cyclic) { node[id].preds = []; order.push(id); }

    // backward pass: latest finish in work-hours (Infinity = no deadline)
    for (let i = order.length - 1; i >= 0; i--) {
      const n = node[order[i]];
      let lf = n.deadline ? tl.H(addDays(n.deadline, 1)) : Infinity;
      for (const s of n.succs) lf = Math.min(lf, node[s].lf - node[s].rem);
      n.lf = lf;
      n.ls = lf - n.rem;
    }

    // forward simulation over Harvey's hours
    const finish = {};
    const ext = order.filter((id) => !isMine(node[id].t));
    for (const id of ext) finish[id] = node[id].externalFinish; // teammates' work
    const mine = order.filter((id) => isMine(node[id].t));
    const left = Object.fromEntries(mine.map((id) => [id, node[id].rem]));
    const started = {};
    const remaining = new Set(mine);
    let h = 0;
    const segments = [];
    // deadlines first, then the task's importance, then the project's priority, then shorter work
    const IMP = { high: 2, normal: 1, low: 0 };
    const prio = (id) => {
      const n = node[id];
      const p = proj[n.t.projectId];
      const imp = IMP[n.t.importance] ?? 1;
      return [n.lf, -(imp * 3 + (p && p.priority != null ? p.priority : 1)), n.rem];
    };
    const cmp = (a, b) => {
      const pa = prio(a), pb = prio(b);
      for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return a < b ? -1 : 1;
    };
    let guard = 0;
    while (remaining.size && guard++ < 100000) {
      const ready = [...remaining].filter(
        (id) => node[id].release <= h + 1e-9 && node[id].preds.every((p) => finish[p] !== undefined && finish[p] <= h + 1e-9)
      );
      // next moment something new can become ready
      const pending = [];
      for (const id of remaining) {
        const n = node[id];
        if (n.release > h + 1e-9) pending.push(n.release);
        for (const p of n.preds) if (finish[p] !== undefined && finish[p] > h + 1e-9) pending.push(finish[p]);
      }
      const nextEvent = pending.length ? Math.min(...pending) : Infinity;
      if (!ready.length) {
        if (nextEvent === Infinity) break; // blocked forever (unresolvable deps)
        h = nextEvent;
        continue;
      }
      ready.sort(cmp);
      const id = ready[0];
      if (started[id] === undefined) started[id] = h;
      const run = Math.min(left[id], nextEvent - h);
      if (run > 1e-9) segments.push({ id, from: h, to: h + run });
      h += Math.max(run, 0);
      left[id] -= run;
      if (left[id] <= 1e-9) {
        finish[id] = h;
        remaining.delete(id);
      }
    }
    const unscheduled = [...remaining];
    const blockedByOthers = ext
      .filter((id) => node[id].t.externalDue && node[id].t.externalDue < today)
      .map((id) => ({ id, title: node[id].t.title, owner: node[id].t.owner, due: node[id].t.externalDue, waiting: node[id].succs }));

    const taskOut = {};
    for (const id of order) {
      const n = node[id];
      const f = finish[id];
      const dlH = n.deadline ? tl.H(addDays(n.deadline, 1)) : null;
      taskOut[id] = {
        id,
        title: n.t.title,
        projectId: n.t.projectId,
        mine: isMine(n.t),
        remainingH: round(n.rem),
        calibratedH: round(n.estCal),
        multiplier: round(n.mult, 2),
        start: started[id] !== undefined ? tl.dateAt(started[id]) : null,
        finish: f === undefined ? null : f === 0 ? today : tl.finishDateAt(f),
        deadline: n.deadline,
        softDeadline: n.soft,
        slackH: dlH === null || f === undefined ? null : round(dlH - f),
        late: dlH !== null && f !== undefined && f > dlH + 1e-6,
        latestStart: n.ls === Infinity ? null : tl.finishDateAt(Math.max(n.ls, 0)),
        missingDeps: n.missingDeps,
      };
    }

    // per-project health
    const projOut = {};
    for (const p of projects || []) {
      const ts = order.filter((id) => node[id].t.projectId === p.id);
      const fins = ts.map((id) => finish[id]).filter((x) => x !== undefined);
      const lastH = fins.length ? Math.max(...fins) : 0;
      const dlH = p.deadline ? tl.H(addDays(p.deadline, 1)) : null;
      projOut[p.id] = {
        id: p.id,
        name: p.name,
        deadline: p.deadline || null,
        openTasks: ts.length,
        remainingH: round(ts.reduce((a, id) => a + node[id].rem, 0)),
        forecastFinish: ts.length ? (fins.length === ts.length ? tl.finishDateAt(lastH) : null) : null,
        slackH: dlH === null || !ts.length ? null : round(dlH - lastH),
        late: dlH !== null && ts.length > 0 && lastH > dlH + 1e-6,
        criticalPath: criticalPath(ts, node),
      };
    }

    return {
      today,
      quantile: o.quantile,
      calibration: cal,
      tasks: taskOut,
      projects: projOut,
      crunch: crunchCheck(order, node, tl, today),
      segments: segments.map((s) => ({ id: s.id, from: round(s.from), to: round(s.to) })),
      unscheduled,
      blockedByOthers,
      daily: dailyLoad(segments, tl, cap, today, 28, o.todayUsed),
      cycles: cyclic,
      horizonHours: round(tl.totalHours),
    };
  }

  // Longest chain of remaining work through a project's dependencies
  // (resource-free CPM). Shows which tasks set the earliest possible finish.
  function criticalPath(ids, node) {
    const set = new Set(ids);
    const memo = {};
    const best = (id) => {
      if (memo[id]) return memo[id];
      let top = { len: 0, path: [] };
      for (const p of node[id].preds) {
        const r = best(p);
        if (r.len > top.len) top = r;
      }
      return (memo[id] = { len: top.len + node[id].rem, path: [...top.path, id] });
    };
    let out = { len: 0, path: [] };
    for (const id of ids) {
      const r = best(id);
      if (r.len > out.len || (r.len === out.len && r.path.length > out.path.length)) out = r;
    }
    return { hours: round(out.len), taskIds: out.path, crossProject: out.path.filter((id) => !set.has(id)) };
  }

  // Demand vs capacity: for each deadline date, hours that must be done by
  // then (that task plus everything feeding it) against hours available by
  // then. The first shortfall is the binding crunch.
  function crunchCheck(order, node, tl, today) {
    const mine = order.filter((id) => isMine(node[id].t) && node[id].lf !== Infinity);
    // a deadline already passed is reported as late, not as a crunch; its hours
    // still count towards the next date that hasn't passed
    const dates = [...new Set(mine.map((id) => node[id].deadline).filter((d) => d && (!today || d >= today)))].sort();
    const rows = dates.map((d) => {
      const haveH = tl.H(addDays(d, 1));
      const ids = mine.filter((id) => node[id].lf <= haveH + 1e-9);
      const needH = ids.reduce((a, id) => a + node[id].rem, 0);
      const hard = ids.some((id) => node[id].deadline === d && !node[id].soft);
      return { by: d, hard, needH: round(needH), haveH: round(haveH), shortH: round(Math.max(0, needH - haveH)) };
    });
    const first = rows.find((r) => r.shortH > 0) || null;
    return { rows, firstShortfall: first };
  }

  // Hours available and hours scheduled per day, for a load chart.
  function dailyLoad(segments, tl, cap, today, days, todayUsed) {
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(today, i);
      const from = tl.H(d), to = tl.H(addDays(d, 1));
      let used = 0;
      for (const s of segments) used += Math.max(0, Math.min(s.to, to) - Math.max(s.from, from));
      out.push({ date: d, capacityH: round(i === 0 ? Math.max(0, cap(d) - (todayUsed || 0)) : cap(d)), scheduledH: round(used) });
    }
    return out;
  }

  // Pick today's work: the schedule's first `hours` of segments, merged per task.
  function todayPlan(fc, hours) {
    const out = [];
    for (const s of fc.segments) {
      if (s.from >= hours - 1e-9) break;
      const h = Math.min(s.to, hours) - s.from;
      const prev = out.find((x) => x.id === s.id);
      if (prev) prev.hours = round(prev.hours + h); else out.push({ id: s.id, title: fc.tasks[s.id].title, hours: round(h) });
    }
    return out;
  }

  function round(x, dp) {
    if (x === null || x === undefined || !isFinite(x)) return x;
    const f = Math.pow(10, dp === undefined ? 1 : dp);
    return Math.round(x * f) / f;
  }

  const api = { calibrate, multiplier, capacityFn, capacityFactor, timeline, forecast, todayPlan, addDays, weekday, daysBetween };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlannerEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
