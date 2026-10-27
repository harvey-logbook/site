// Turns a day's calendar events into free blocks, then lays the schedule's
// first hours into those blocks. Times are minutes after local midnight.
(function (root) {
  'use strict';

  function toMin(hm) {
    const [h, m] = String(hm).split(':').map(Number);
    return h * 60 + (m || 0);
  }
  function hhmm(mins) {
    mins = Math.max(0, Math.min(1440, Math.round(mins)));
    return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  }

  // events: [{start: Date, end: Date, busy: boolean}] already for this day.
  // opts: dayStart/dayEnd 'HH:MM', bufferMin around events, minBlockMin,
  // nowMin (minutes after midnight; blocks start no earlier than this).
  function freeBlocks(events, opts) {
    const o = Object.assign({ dayStart: '08:30', dayEnd: '22:00', bufferMin: 10, minBlockMin: 25, nowMin: 0 }, opts || {});
    const startDay = Math.max(toMin(o.dayStart), Math.ceil((o.nowMin || 0) / 5) * 5);
    const endDay = toMin(o.dayEnd);
    const busy = events
      .filter((e) => e.busy !== false)
      .map((e) => [Math.max(0, e.startMin - o.bufferMin), Math.min(1440, e.endMin + o.bufferMin)])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of busy) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push(iv.slice());
    }
    const blocks = [];
    let cur = startDay;
    for (const [a, b] of merged) {
      if (a > cur) blocks.push([cur, Math.min(a, endDay)]);
      cur = Math.max(cur, b);
      if (cur >= endDay) break;
    }
    if (cur < endDay) blocks.push([cur, endDay]);
    // tidy edges: starts up to the next 5 min, ends down to the previous 5
    return blocks
      .map(([a, b]) => [Math.ceil(a / 5) * 5, Math.floor(b / 5) * 5])
      .filter(([a, b]) => b - a >= o.minBlockMin)
      .map(([a, b]) => ({ startMin: a, endMin: b, start: hhmm(a), end: hhmm(b), minutes: b - a }));
  }

  // items: [{id, title, hours}] in priority order. Fills blocks in time order,
  // splitting a task across blocks when it runs past one. Rounds to 5 min.
  function assign(blocks, items) {
    const out = [];
    let bi = 0;
    let pos = blocks.length ? blocks[0].startMin : 0;
    for (const it of items) {
      let need = Math.round((it.hours * 60) / 5) * 5;
      while (need > 0 && bi < blocks.length) {
        const b = blocks[bi];
        if (pos < b.startMin) pos = b.startMin;
        const room = b.endMin - pos;
        if (room < 15) { bi++; continue; }
        const take = Math.min(room, need);
        out.push({ taskId: it.id, title: it.title, start: hhmm(pos), end: hhmm(pos + take), minutes: take });
        pos += take;
        need -= take;
        if (b.endMin - pos < 15) bi++;
      }
    }
    return out;
  }

  // Calendar event (Google shape) -> {startMin, endMin, busy, title} for one
  // local date, or null when it doesn't touch that date or is all-day.
  function clipEvent(ev, dateStr) {
    if (!ev || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return null;
    if (ev.status === 'cancelled') return null;
    const s = new Date(ev.start.dateTime), e = new Date(ev.end.dateTime);
    const [y, m, d] = dateStr.split('-').map(Number);
    const day0 = new Date(y, m - 1, d, 0, 0, 0).getTime();
    const day1 = new Date(y, m - 1, d + 1, 0, 0, 0).getTime();
    if (e.getTime() <= day0 || s.getTime() >= day1) return null;
    // wall-clock minutes, so days when the clocks change still read right
    const startMin = s.getTime() <= day0 ? 0 : s.getHours() * 60 + s.getMinutes();
    const endMin = e.getTime() >= day1 ? 1440 : e.getHours() * 60 + e.getMinutes();
    const busy = ev.transparency !== 'transparent' && ev.availability !== 'AVAILABILITY_FREE';
    return { startMin, endMin, busy, title: ev.summary || '(busy)', start: hhmm(startMin), end: hhmm(endMin) };
  }

  const api = { freeBlocks, assign, clipEvent, toMin, hhmm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DayPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
