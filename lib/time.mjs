// Time windows shared by git, sessions and the daily log. Everything in epoch ms.
export function parseSince(value, now = Date.now()) {
  const rel = /^(\d+)\s*([mhd])$/.exec(value);
  if (rel) return now - Number(rel[1]) * { m: 6e4, h: 36e5, d: 864e5 }[rel[2]];
  const abs = Date.parse(value);
  if (Number.isNaN(abs)) throw new Error(`Invalid date: "${value}" (use 90m, 24h, 7d or an ISO date)`);
  return abs;
}

// A calendar day in local time: today, yesterday or YYYY-MM-DD
export function dayRange(value = 'today', now = new Date()) {
  let d;
  if (value === 'today' || value === 'yesterday') {
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (value === 'yesterday' ? 1 : 0));
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) throw new Error(`Invalid date: "${value}" (use today, yesterday or YYYY-MM-DD)`);
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const from = d.getTime();
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { date: localDate(from), from, to };
}

export const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// YYYY-MM-DD plus n calendar days (n < 0 goes back), safe across DST changes
export const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n).getTime());
};
export const hhmm =(iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// Active time from activity marks [start, end] in ms (like Flavio Copes' Factory Log):
// marks less than `gap` apart form one block, and each block adds `lead` for the work before its first mark.
// shortcut: an agent session counts in full from first to last message even with idle stretches inside; if it inflates, store per-message marks
export function activeTime(spans, { gap = 60 * 6e4, lead = 5 * 6e4 } = {}) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let ms = 0;
  let blocks = 0;
  for (let i = 0; i < sorted.length; ) {
    let [start, end] = sorted[i++];
    while (i < sorted.length && sorted[i][0] - end <= gap) end = Math.max(end, sorted[i++][1]);
    ms += end - start + lead;
    blocks++;
  }
  return { ms, blocks };
}

export const duration = (ms) => {
  const m = Math.round(ms / 6e4);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
