'use strict';

function zoneCheck(zone) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(); }
  catch { throw new Error(`invalid timezone "${zone}"`); }
  return zone;
}
function partsAt(ms, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
}
function utc(y, m = 1, d = 1) {
  const v = new Date(0); v.setUTCFullYear(y, m - 1, d); v.setUTCHours(0, 0, 0, 0); return v.getTime();
}
function midnight(y, m, d, zone) {
  const target = utc(y, m, d);
  let guess = target;
  for (let n = 0; n < 6; n++) {
    const p = partsAt(guess, zone);
    const shown = utc(p.year, p.month, p.day) + p.hour * 3600000 + p.minute * 60000 + p.second * 1000;
    const next = guess + target - shown;
    if (next === guess) return guess;
    guess = next;
  }
  throw new Error(`local midnight does not exist on ${y}-${m}-${d} in ${zone}; use an explicit timestamp`);
}
function period(value, zone, now = Date.now()) {
  let s = String(value).trim();
  if (s === 'today' || s === 'yesterday') {
    const p = partsAt(now, zone);
    const day = new Date(utc(p.year, p.month, p.day) - (s === 'yesterday' ? 86400000 : 0));
    s = day.toISOString().slice(0, 10);
  }
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  if (match) {
    const y = +match[1], m = +(match[2] || 1), d = +(match[3] || 1);
    const dt = new Date(utc(y, m, d));
    if (y < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new Error(`invalid calendar date "${s}"`);
    const next = new Date(utc(y + (!match[2] ? 1 : 0), m + (match[2] && !match[3] ? 1 : 0), d + (match[3] ? 1 : 0)));
    return { start: midnight(y, m, d, zone), end: midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), zone), resolved: s };
  }
  // No host-local timestamps or Date.parse's rollover of invalid calendar dates.
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!iso || +iso[2] > 23 || +iso[3] > 59 || +(iso[4] || 0) > 59) throw new Error(`invalid date "${s}"; use YYYY[-MM[-DD]], today, yesterday, or an ISO timestamp with timezone`);
  period(iso[1], 'UTC', now);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`invalid timestamp "${s}"`);
  return { start: t, end: t + 1, resolved: s };
}

function range(a, zone, now) {
  zoneCheck(zone);
  if (a.on && [a.since, a.from, a.until, a.to, a.before, a.after].some(Boolean)) throw new Error('--on cannot be combined with other date bounds');
  if ((a.since && a.from) || (a.until && a.to) || ((a.since || a.from) && a.after) || ((a.until || a.to) && a.before)) throw new Error('conflicting date bounds');
  const startValue = a.on || a.since || a.from || a.after;
  const endValue = a.on || a.until || a.to || a.before;
  const start = startValue ? period(startValue, zone, now) : null;
  const end = endValue ? period(endValue, zone, now) : null;
  const lo = start ? (a.after ? start.end : start.start) : null;
  const hi = end ? (a.before ? end.start : end.end) : null;
  if (lo !== null && hi !== null && lo >= hi) throw new Error('date range is empty or reversed');
  return { lo, hi, timezone: zone, since: start?.resolved, until: end?.resolved };
}

// Original stored timestamps are kept verbatim. Invalid/zone-less times never acquire a guessed timezone.
function eventTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(String(s));
  if (!m || +m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59) return null;
  const day = new Date(utc(+m[1], +m[2], +m[3]));
  if (day.getUTCFullYear() !== +m[1] || day.getUTCMonth() + 1 !== +m[2] || day.getUTCDate() !== +m[3]) return null;
  const n = Date.parse(s); return Number.isFinite(n) ? n : null;
}
module.exports = { range, period, eventTime, partsAt };
