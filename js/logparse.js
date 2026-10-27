// Reads a typed or dictated log line ("finished gearbox CAD, two and a half
// hours") into a duration, optional clock times, a done flag and the best
// matching task. No model involved; the page only asks Claude when this
// comes back unsure.
(function (root) {
  'use strict';

  const SMALL = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
  const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

  const STOP = new Set(
    ('i im ive i\'ve just did do doing done worked work working spent spend on for the a an of with and to my some ' +
      'bit hour hours hr hrs h minute minutes min mins m today tonight this morning afternoon evening yesterday from ' +
      'till until til about around roughly approx approximately ish got been was were have had more then also ' +
      'finished finish finishing completed complete submitted sent off ticked wrapped up still not yet started start ' +
      'continue continued carry carried in at it its that so session task tasks bits stuff thing things lot little ' +
      'between half quarter few couple')
      .split(' ')
  );

  function normalise(text) {
    let s = ' ' + String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/[,;!?]/g, ' ') + ' ';
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/\bthree quarters of an hour\b/g, '45 min');
    s = s.replace(/\b(a )?quarter of an hour\b/g, '15 min');
    s = s.replace(/\b(an )?hour and a half\b/g, '1.5 hours');
    s = s.replace(/\b(an )?hour and a quarter\b/g, '1.25 hours');
    s = s.replace(/\bhalf an hour\b|\ba half hour\b|\bhalf hour\b/g, '30 min');
    s = s.replace(/\ba couple of hours\b|\bcouple of hours\b|\bcouple hours\b/g, '2 hours');
    s = s.replace(/\b(an|one) hour\b/g, '1 hour');
    // compound numbers: forty five -> 45
    s = s.replace(/\b(twenty|thirty|forty|fifty)[ -](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, t, u) => String(TENS[t] + UNITS[u]));
    s = s.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety)\b/g, (w) => String(SMALL[w]));
    s = s.replace(/\b(\d+) and a half\b/g, (_, n) => String(+n + 0.5));
    s = s.replace(/\b(\d+) and a quarter\b/g, (_, n) => String(+n + 0.25));
    s = s.replace(/\b(\d+) and three quarters\b/g, (_, n) => String(+n + 0.75));
    s = s.replace(/\b(\d+(?:\.\d+)?) (?:and )?a half hours?\b/g, (_, n) => String(+n + 0.5) + ' hours');
    return s;
  }

  function to24(h, m, ap, fallbackPm) {
    h = +h; m = +(m || 0);
    if (ap === 'pm' && h < 12) h += 12;
    else if (ap === 'am' && h === 12) h = 0;
    else if (!ap && fallbackPm && h < 12) h += 12;
    return h * 60 + m;
  }
  function hhmm(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
  }

  function findTimes(s) {
    const re = /\b(from|between)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till|til|and)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b(?!\s*(?:h|hr|hrs|hours?|min|mins|minutes?)\b)/;
    const m = s.match(re);
    if (!m) return null;
    const [whole, lead, h1, m1, ap1, h2, m2, ap2] = m;
    const clockish = lead || ap1 || ap2 || m1 || m2;
    if (!clockish) return null;
    if (lead === 'between' || (!lead && whole.includes(' and '))) {
      if (!(ap1 || ap2 || m1 || m2)) return null;
    }
    if (+h1 > 23 || +h2 > 23 || +(m1 || 0) > 59 || +(m2 || 0) > 59) return null;
    // am/pm inference: "2 to 4:30pm" -> both pm; bare small hours are afternoon
    const endAp = ap2 || null;
    const startAp = ap1 || (endAp && +h1 <= +h2 && +h2 !== 12 ? endAp : null);
    let start = to24(h1, m1, startAp, !startAp && +h1 >= 1 && +h1 <= 7);
    let end = to24(h2, m2, endAp, !endAp && +h2 >= 1 && +h2 <= 7);
    if (!endAp && end <= start && end + 720 > start) end += 720;
    let minutes = end - start;
    if (minutes <= 0) minutes += 1440;
    if (minutes > 16 * 60) return null;
    return { whole, start: hhmm(start), end: hhmm(end), minutes };
  }

  function findDuration(s) {
    let m = s.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\.?(?:\s*(?:and\s*)?(\d{1,2})\s*(?:m|min|mins|minute|minutes)\b)?/);
    if (m) return { whole: m[0], minutes: Math.round(+m[1] * 60 + +(m[2] || 0)) };
    m = s.match(/\b(\d+)\s*h\s*(\d{1,2})\b/);
    if (m) return { whole: m[0], minutes: +m[1] * 60 + +m[2] };
    m = s.match(/\b(\d+)\s*(?:m|min|mins|minute|minutes)\b/);
    if (m) return { whole: m[0], minutes: +m[1] };
    return null;
  }

  function stem(w) {
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }
  function tokens(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9+#.\s-]/g, ' ')
      .split(/[\s\-/.]+/)
      .filter((w) => w && (w.length > 1 || /\d/.test(w)))
      .map(stem);
  }
  function hit(a, b) {
    if (a === b) return true;
    if (a.length >= 4 && b.length >= 4) return a.startsWith(b) || b.startsWith(a);
    return false;
  }

  function parseLog(text, ctx) {
    const c = Object.assign({ tasks: [], projects: [], now: new Date() }, ctx || {});
    const s = normalise(text);
    const out = { minutes: null, start: null, end: null, dayOffset: 0, done: null, taskId: null, projectId: null, title: '', candidates: [], confident: false, issues: [] };

    let rest = s;
    const times = findTimes(s);
    if (times) {
      out.minutes = times.minutes; out.start = times.start; out.end = times.end;
      rest = rest.replace(times.whole, ' ');
    } else {
      const d = findDuration(s);
      if (d) { out.minutes = d.minutes; rest = rest.replace(d.whole, ' '); }
    }
    if (/\byesterday\b/.test(s)) out.dayOffset = -1;

    if (/\b(not (yet )?(finished|done|complete|completed)|unfinished|half ?way|partly|partially|in progress|still (working|going)|more to do|carry on|carried on|continue|continued|started)\b/.test(s)) out.done = false;
    else if (/\b(finished|finish off|done|completed?|submitted|sent off|sent|ticked off|wrapped up)\b/.test(s)) out.done = true;

    const words = tokens(rest).filter((w) => !STOP.has(w));
    const projTok = {};
    for (const p of c.projects) projTok[p.id] = tokens([p.name].concat(p.aliases || []).join(' '));

    // project guess from any word
    let bestProj = null, bestProjHits = 0;
    for (const p of c.projects) {
      const h = words.filter((w) => projTok[p.id].some((t) => hit(w, t))).length;
      if (h > bestProjHits) { bestProj = p.id; bestProjHits = h; }
    }

    const recent = (t) => t.status !== 'done' && t.status !== 'dropped';
    const scored = c.tasks
      .filter((t) => t.status !== 'dropped')
      .map((t) => {
        const tt = tokens(t.title);
        const titleHits = words.filter((w) => tt.some((x) => hit(w, x))).length;
        const projHits = words.filter((w) => (projTok[t.projectId] || []).some((x) => hit(w, x))).length;
        const coverage = tt.length ? tt.filter((x) => words.some((w) => hit(w, x))).length / tt.length : 0;
        const score = titleHits * 2 + projHits + coverage + (recent(t) ? 0.5 : 0);
        // one shared word ("plan") isn't enough on its own to pick a task, and a
        // teammate's task needs a real title match, not just its project's name
        const titleStrong = titleHits >= 2 || coverage >= 0.5;
        const mine = !t.owner || t.owner === 'me';
        const strong = titleStrong || (mine && projHits >= 1);
        return { id: t.id, score, titleHits, projHits, titleStrong, projectId: t.projectId, strong };
      })
      .filter((x) => x.titleHits > 0)
      .sort((a, b) => b.score - a.score);
    out.candidates = scored.slice(0, 4).map((x) => ({ id: x.id, score: Math.round(x.score * 100) / 100 }));

    // a weak title match loses to a project the words point at more clearly
    // ("propeller designer" is the propeller project, not a gearbox "design" task)
    const outvoted = (x) => !x.titleStrong && bestProj && bestProj !== x.projectId && bestProjHits > x.projHits;
    if (scored.length && scored[0].strong && !outvoted(scored[0]) && (scored.length === 1 || scored[0].score > scored[1].score)) {
      out.taskId = scored[0].id;
      const t = c.tasks.find((x) => x.id === out.taskId);
      out.projectId = t.projectId;
    } else {
      out.projectId = bestProj;
      if (scored.length > 1 && scored[0].strong) out.issues.push('Two tasks match equally; pick one.');
    }

    rest = rest.replace(/\b(not (yet )?(finished|done|complete|completed)( yet)?|unfinished|half ?way|partly|partially|in progress|still (working|going)( on)?|more to do|carry on|carried on|continued?|started|finished|finish off|done|completed?|submitted|sent off|ticked off|wrapped up)\b/g, ' ');
    const titleWords = tokens(rest).filter((w) => !STOP.has(w) || /\d/.test(w));
    let raw = rest.replace(/\s+/g, ' ').trim()
      .replace(/^(i |just |i've |ive )+/, '')
      .replace(/^(finished|done|completed|did|worked on|spent|submitted|sent)\s+/, '')
      .replace(/\b(today|yesterday|this morning|this afternoon|this evening)\b/g, '')
      .replace(/\s+(on|for|of|and)$/, '')
      .replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) raw = raw.replace(/^(on|for|the|a|an|of|some|more|bit of|and)\s+/, '');
    // keep the user's own capitals (SELA, CAD, OpenWorks)
    const caps = {};
    for (const w of String(text || '').split(/[^A-Za-z0-9+#'’.-]+/)) {
      const k = w.toLowerCase().replace(/’/g, "'");
      if (k && /[A-Z]/.test(w) && !caps[k]) caps[k] = w.replace(/’/g, "'");
    }
    raw = raw.split(' ').map((w) => caps[w] || w).join(' ');
    out.title = titleWords.length ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';

    if (!out.minutes) out.issues.push('No time found. Add something like "45 min" or "2 h".');
    if (!out.taskId && !out.projectId) out.issues.push('No task or project recognised.');
    out.confident = !!out.minutes && out.minutes > 0 && out.minutes <= 16 * 60 && (!!out.taskId || (!!out.projectId && out.title.length >= 3));
    return out;
  }

  const api = { parseLog, normalise, findTimes, findDuration, tokens };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
