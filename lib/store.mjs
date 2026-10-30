// Deterministic SQLite store: commits by hash, sessions by (agent, id, day). Collecting twice never duplicates,
// and what is stored survives even if an agent deletes its old logs. Every row says which machine it came from.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { activeTime, addDays, dayRange, duration, hhmm, localDate, parseSince } from './time.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (path TEXT PRIMARY KEY, seen_at TEXT NOT NULL, machine TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY, short TEXT NOT NULL, day TEXT NOT NULL, date TEXT NOT NULL, author TEXT NOT NULL,
  subject TEXT NOT NULL, files INTEGER NOT NULL, insertions INTEGER NOT NULL, deletions INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS commits_day ON commits (day);
CREATE TABLE IF NOT EXISTS commit_refs (hash TEXT NOT NULL, repo TEXT NOT NULL, ref TEXT NOT NULL, branch TEXT, machine TEXT NOT NULL DEFAULT '', PRIMARY KEY (hash, repo));
CREATE TABLE IF NOT EXISTS sessions (
  tool TEXT NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL, project TEXT, title TEXT, model TEXT,
  start TEXT NOT NULL, end TEXT NOT NULL, tool_calls INTEGER NOT NULL, prompts TEXT NOT NULL, files TEXT NOT NULL,
  machine TEXT NOT NULL DEFAULT '', PRIMARY KEY (tool, id, day));
CREATE INDEX IF NOT EXISTS sessions_day ON sessions (day);
CREATE TABLE IF NOT EXISTS pending (day TEXT NOT NULL, repo TEXT NOT NULL, file TEXT NOT NULL, status TEXT NOT NULL, machine TEXT NOT NULL DEFAULT '', PRIMARY KEY (day, repo, file));
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, day TEXT NOT NULL, at TEXT NOT NULL, project TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL, machine TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS reports_day ON reports (day);
CREATE TABLE IF NOT EXISTS agent_paths (agent TEXT PRIMARY KEY, path TEXT NOT NULL, method TEXT NOT NULL, answer TEXT, checked_at TEXT NOT NULL);
`;

const MACHINE_TABLES = ['repos', 'commit_refs', 'sessions', 'pending', 'reports'];

// machine: the label of this computer; rows from before labels existed are given it
export async function openStore(file, machine = 'local') {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000'); // the bot and cron may write at the same time
  db.exec(SCHEMA);
  for (const t of MACHINE_TABLES) {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'machine')) db.exec(`ALTER TABLE ${t} ADD COLUMN machine TEXT NOT NULL DEFAULT ''`);
    db.prepare(`UPDATE ${t} SET machine = ? WHERE machine = ''`).run(machine);
  }
  return new Store(db, machine);
}

class Store {
  constructor(db, machine) {
    this.db = db;
    this.machine = machine;
  }
  close() {
    this.db.close();
  }
  tx(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  saveGit({ repos, projects }, { to }, clean) {
    const now = new Date().toISOString();
    const repo = this.db.prepare('INSERT INTO repos VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET seen_at = excluded.seen_at');
    this.tx(() => {
      for (const r of repos) repo.run(r, now, this.machine);
      for (const p of projects) for (const c of p.commits) this.#commit({ ...c, refs: [{ repo: p.repo, ref: c.ref, branch: p.branch }] }, this.machine, clean);
      // Uncommitted changes are a snapshot of "now": replaced as a whole for today
      if (to >= Date.now() - 60_000) {
        const today = localDate(Date.now());
        this.db.prepare('DELETE FROM pending WHERE day = ? AND machine = ?').run(today, this.machine);
        for (const p of projects) for (const f of p.pending) this.#pending({ day: today, repo: p.repo, file: f.file, status: f.status }, this.machine, clean);
      }
    });
  }

  #commit(c, machine, clean) {
    this.db.prepare(`INSERT INTO commits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET
      subject = excluded.subject, files = excluded.files, insertions = excluded.insertions, deletions = excluded.deletions`)
      .run(c.hash, c.short, localDate(Date.parse(c.date)), c.date, clean(c.author), clean(c.subject), c.files, c.insertions, c.deletions);
    // a clone at the same path on two machines stays with the first machine that recorded it
    const ref = this.db.prepare('INSERT INTO commit_refs VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash, repo) DO UPDATE SET ref = excluded.ref, branch = excluded.branch WHERE machine = excluded.machine');
    for (const r of c.refs) ref.run(c.hash, r.repo, r.ref, r.branch ?? null, machine);
  }
  #pending(p, machine, clean) {
    this.db.prepare('INSERT INTO pending VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET status = excluded.status WHERE machine = excluded.machine').run(p.day, p.repo, clean(p.file), p.status, machine);
  }
  #session(s, machine, clean) {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(s.tool, s.id, s.day, s.project, clean(s.title), s.model, s.start, s.end,
      s.toolCalls, JSON.stringify(s.prompts.map((t) => clean(t))), JSON.stringify(s.files.map((t) => clean(t))), machine);
  }

  saveSessions(sessions, clean) {
    this.tx(() => {
      for (const s of sessions) this.#session(s, this.machine, clean);
    });
  }

  // What an agent says it finished (atalaya report). The id is a hash of the content: repeating it doesn't duplicate
  saveReport({ at, project, source, summary }, clean, machine = this.machine) {
    const text = clean(summary);
    const id = createHash('sha256').update([at, project, source, text].join('\0')).digest('hex').slice(0, 16);
    this.db.prepare('INSERT OR IGNORE INTO reports VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, localDate(Date.parse(at)), at, project, source, text, machine);
    return id;
  }

  // One machine's day as plain data, in a stable order: the same day exports to the same bytes (a git-friendly file).
  // Folders in hide never leave the machine
  exportDay(day, hide = []) {
    const m = this.machine;
    const shown = (path) => !path || !hide.some((dir) => under(path, dir));
    const commits = this.db
      .prepare('SELECT c.* FROM commits c WHERE c.day = ? AND EXISTS (SELECT 1 FROM commit_refs r WHERE r.hash = c.hash AND r.machine = ?) ORDER BY c.hash')
      .all(day, m)
      .map((c) => ({ ...c, refs: this.db.prepare('SELECT repo, ref, branch FROM commit_refs WHERE hash = ? AND machine = ? ORDER BY repo').all(c.hash, m).filter((r) => shown(r.repo)) }))
      .filter((c) => c.refs.length);
    const sessions = this.db.prepare('SELECT * FROM sessions WHERE day = ? AND machine = ? ORDER BY tool, id').all(day, m)
      .filter((s) => shown(s.project))
      .map(({ machine, tool_calls, prompts, files, ...s }) => ({ ...s, toolCalls: tool_calls, prompts: JSON.parse(prompts), files: JSON.parse(files) }));
    const reports = this.db.prepare('SELECT at, project, source, summary FROM reports WHERE day = ? AND machine = ? ORDER BY id').all(day, m).filter((r) => shown(r.project));
    const pending = this.db.prepare('SELECT day, repo, file, status FROM pending WHERE day = ? AND machine = ? ORDER BY repo, file').all(day, m).filter((p) => shown(p.repo));
    const repos = this.db.prepare('SELECT path FROM repos WHERE machine = ? ORDER BY path').all(m).map((r) => r.path).filter(shown);
    if (!commits.length && !sessions.length && !reports.length && !pending.length) return null;
    return { machine: m, day, repos, commits: commits.map(({ machine, ...c }) => c), sessions, reports, pending };
  }

  // Another machine's exported day. Idempotent like everything else, and redacted again: the file came from outside
  importDay(machine, data, clean) {
    const now = new Date().toISOString();
    this.tx(() => {
      for (const path of data.repos ?? []) this.db.prepare('INSERT INTO repos VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING').run(path, now, machine);
      for (const c of data.commits ?? []) this.#commit(c, machine, clean);
      for (const s of data.sessions ?? []) this.#session(s, machine, clean);
      for (const r of data.reports ?? []) this.saveReport(r, clean, machine);
      this.db.prepare('DELETE FROM pending WHERE day = ? AND machine = ?').run(data.day, machine);
      for (const p of data.pending ?? []) this.#pending(p, machine, clean);
    });
  }

  savePath(agent, { path, method, answer }) {
    this.db.prepare('INSERT OR REPLACE INTO agent_paths VALUES (?, ?, ?, ?, ?)').run(agent, path, method, answer ?? null, new Date().toISOString());
  }
  paths() {
    return Object.fromEntries(this.db.prepare('SELECT agent, path FROM agent_paths').all().map((r) => [r.agent, r.path]));
  }

  days(fromDay, toDay) {
    return this.db
      .prepare(`SELECT day FROM commits WHERE day BETWEEN ? AND ? UNION SELECT day FROM sessions WHERE day BETWEEN ? AND ?
                UNION SELECT day FROM pending WHERE day BETWEEN ? AND ? UNION SELECT day FROM reports WHERE day BETWEEN ? AND ? ORDER BY day`)
      .all(fromDay, toDay, fromDay, toDay, fromDay, toDay, fromDay, toDay)
      .map((r) => r.day);
  }

  // Folder → the repo it belongs to: a session in /r/a/sub is part of /r/a
  #owner() {
    const repos = this.db.prepare('SELECT path FROM repos').all().map((r) => r.path).sort((a, b) => b.length - a.length);
    return (dir) => (dir && repos.find((r) => dir === r || dir.startsWith(r + '/'))) ?? dir ?? '(no folder)';
  }

  // Per project since a day: last active day, commits and agent session-days (sessions and reports), on any machine.
  // Oldest first, which is what "stale" wants
  activitySince(fromDay, toDay = '9999-12-31') {
    const owner = this.#owner();
    const rows = this.db
      .prepare(`SELECT r.repo AS dir, c.day, c.hash, r.machine FROM commits c JOIN commit_refs r ON r.hash = c.hash WHERE c.day BETWEEN ? AND ?
                UNION ALL SELECT project, day, NULL, machine FROM sessions WHERE day BETWEEN ? AND ?
                UNION ALL SELECT project, day, NULL, machine FROM reports WHERE day BETWEEN ? AND ?`)
      .all(fromDay, toDay, fromDay, toDay, fromDay, toDay);
    const projects = new Map();
    for (const r of rows) {
      const key = owner(r.dir);
      if (!projects.has(key)) projects.set(key, { project: key, last: r.day, commits: new Set(), sessions: 0, machines: new Set() });
      const p = projects.get(key);
      if (r.day > p.last) p.last = r.day;
      if (r.hash) p.commits.add(r.hash);
      else p.sessions++;
      p.machines.add(r.machine);
    }
    return [...projects.values()]
      .map((p) => ({ ...p, commits: p.commits.size, machines: [...p.machines].sort() }))
      .sort((a, b) => a.last.localeCompare(b.last) || a.project.localeCompare(b.project));
  }

  // The latest snapshot of uncommitted files up to a day: the nightly run for yesterday takes it just after midnight
  pendingUpTo(day) {
    return this.db.prepare('SELECT * FROM pending WHERE day = (SELECT MAX(day) FROM pending WHERE day <= ?) ORDER BY repo, file, machine').all(day);
  }

  // Everything for one day grouped by project folder, in a stable order
  day(day, project) {
    const owner = this.#owner();
    const groups = new Map();
    const group = (key, machine) => {
      const id = `${machine}\0${key}`;
      if (!groups.has(id)) groups.set(id, { project: key, machine, commits: [], sessions: [], reports: [], pending: [] });
      return groups.get(id);
    };

    const refs = this.db.prepare('SELECT repo, ref, machine FROM commit_refs WHERE hash = ? ORDER BY machine, repo');
    // dates carry the committer's time zone: sort by instant, not by text
    const commits = this.db.prepare('SELECT * FROM commits WHERE day = ?').all(day);
    commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.hash.localeCompare(b.hash));
    for (const c of commits) {
      const [first, ...others] = refs.all(c.hash); // the same commit in several clones is listed once
      group(first.repo, first.machine).commits.push({ ...c, ref: first.ref, alsoIn: others.map((o) => o.repo) });
    }
    for (const s of this.db.prepare('SELECT * FROM sessions WHERE day = ? ORDER BY start, tool, id').all(day)) {
      group(owner(s.project), s.machine).sessions.push({ ...s, prompts: JSON.parse(s.prompts), files: JSON.parse(s.files) });
    }
    for (const r of this.db.prepare('SELECT * FROM reports WHERE day = ? ORDER BY at, id').all(day)) group(owner(r.project), r.machine).reports.push(r);
    for (const p of this.db.prepare('SELECT * FROM pending WHERE day = ? ORDER BY repo, file').all(day)) group(p.repo, p.machine).pending.push(p);

    return [...groups.values()]
      .filter((g) => !project || g.project.includes(project))
      .sort((a, b) => a.project.localeCompare(b.project) || a.machine.localeCompare(b.machine));
  }
}

// ---------- Markdown export: what the agent receives ----------
const under = (path, dir) => path === dir || path.startsWith(dir + '/');

// view: { aliases: [[path, name]] longest first, hide: [paths] }. Only changes what is shown, not what is stored
const shortener = (aliases) => (p) => {
  const hit = aliases.find(([dir]) => under(p, dir));
  return hit ? hit[1] + p.slice(hit[0].length) : p.replace(homedir(), '~');
};

// Activity marks of a day's group, for the estimated time
const spans = (g) => [
  ...g.commits.map((c) => [Date.parse(c.date), Date.parse(c.date)]),
  ...g.sessions.map((s) => [Date.parse(s.start), Date.parse(s.end)]),
  ...g.reports.map((r) => [Date.parse(r.at), Date.parse(r.at)]),
];

export function toMarkdown(day, allGroups, { aliases = [], hide = [] } = {}) {
  const short = shortener(aliases);
  const rel = (file, project) => (file.startsWith(project + '/') ? file.slice(project.length + 1) : short(file));
  const groups = allGroups.filter((g) => !hide.some((dir) => under(g.project, dir)));
  // With a single machine nothing changes; with several, each project says where it happened
  const machines = [...new Set(groups.map((g) => g.machine))].sort();
  const where = (g) => (machines.length > 1 ? ` · ${g.machine}` : '');
  const out = [`# Recorded activity · ${day}`, ''];
  if (machines.length > 1) out.push(`Machines: ${machines.join(', ')}`, '');
  if (!groups.length) out.push('_No recorded activity._', '');
  for (const g of groups) {
    const time = activeTime(spans(g));
    out.push(`## ${short(g.project)}${where(g)}`, '');
    if (time.blocks) out.push(`Estimated time: ${duration(time.ms)} in ${time.blocks} ${time.blocks === 1 ? 'block' : 'blocks'}`, '');
    if (g.commits.length) {
      out.push(`### Commits (${g.commits.length})`, '');
      for (const c of g.commits) {
        const also = c.alsoIn.length ? ` · also in ${c.alsoIn.map(short).join(', ')}` : '';
        out.push(`- \`${c.short}\` ${hhmm(c.date)} · ${c.author} · \`${c.ref}\` · ${c.subject} (+${c.insertions}/-${c.deletions}, ${c.files} files)${also}`);
      }
      out.push('');
    }
    if (g.sessions.length) {
      out.push(`### Agent sessions (${g.sessions.length})`, '');
      for (const s of g.sessions) {
        out.push(`#### ${s.tool} · ${hhmm(s.start)}→${hhmm(s.end)} · ${s.title ?? '(untitled)'}`, '');
        out.push(`- Session: \`${s.id}\`${s.model ? ` · model: ${s.model}` : ''} · tool calls: ${s.tool_calls}`);
        if (s.project && s.project !== g.project) out.push(`- Folder: \`${short(s.project)}\``);
        if (s.files.length) out.push(`- Edited files: ${s.files.map((f) => `\`${rel(f, g.project)}\``).join(', ')}`);
        if (s.prompts.length) {
          out.push('- Prompts:');
          for (const p of s.prompts) out.push(`  - ${p}`);
        }
        out.push('');
      }
    }
    if (g.reports.length) {
      out.push(`### Agent reports (${g.reports.length})`, '');
      for (const r of g.reports) out.push(`- ${hhmm(r.at)} · ${r.source}${r.project !== g.project ? ` · \`${short(r.project)}\`` : ''} · ${r.summary}`);
      out.push('');
    }
    if (g.pending.length) {
      out.push(`### Uncommitted (${g.pending.length})`, '');
      for (const p of g.pending) out.push(`- \`${p.status}\` ${p.file}`);
      out.push('');
    }
  }
  return out.join('\n');
}

// ---------- stale projects ----------
// projects: activitySince(window start). Lists the ones whose last activity is before idleSince
// temp folders (agent scratchpads, test runs) are not projects
const TEMP = /^(\/private)?\/(tmp|var\/folders)\//;
const watchedOnly = (projects, hide) => projects.filter((p) => p.project !== '(no folder)' && !TEMP.test(p.project) && !hide.some((dir) => under(p.project, dir)));
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);

export function toStaleMarkdown(projects, { today, idleSince, idle, window }, { aliases = [], hide = [] } = {}) {
  const short = shortener(aliases);
  const watched = watchedOnly(projects, hide);
  const stale = watched.filter((p) => p.last < idleSince);
  const several = new Set(watched.flatMap((p) => p.machines)).size > 1;
  const out = [`# Stale projects · ${today}`, '', `Active in the last ${window} but untouched for ${idle}: ${stale.length} of ${watched.length} projects.`, ''];
  if (!stale.length) return [...out, '_Nothing stale._', ''].join('\n');
  out.push(`| Project | Last activity | Idle | Commits | Agent session-days |${several ? ' Machines |' : ''}`, `|---|---|---|---|---|${several ? '---|' : ''}`);
  for (const p of stale) out.push(`| ${short(p.project)} | ${p.last} | ${daysBetween(p.last, today)} days | ${p.commits} | ${p.sessions} |${several ? ` ${p.machines.join(', ')} |` : ''}`);
  return [...out, ''].join('\n');
}

// ---------- JSON: the same data for dashboards and other systems ----------
// Bump on any change that isn't adding a field. Documented in the README ("JSON output")
export const SCHEMA_VERSION = 1;

export function toStaleJson(projects, { today, idleSince, idle, window }, { aliases = [], hide = [] } = {}) {
  const short = shortener(aliases);
  const watched = watchedOnly(projects, hide);
  const stale = watched
    .filter((p) => p.last < idleSince)
    .map((p) => ({ path: p.project, name: short(p.project), lastActivity: p.last, idleDays: daysBetween(p.last, today), commits: p.commits, sessionDays: p.sessions, machines: p.machines }));
  return { schemaVersion: SCHEMA_VERSION, today, idle, window, watched: watched.length, stale };
}

// A day as toMarkdown shows it, without prompts or edited file names: titles, counts, paths and timestamps
export function toDayJson(day, allGroups, { aliases = [], hide = [] } = {}) {
  const short = shortener(aliases);
  const groups = allGroups.filter((g) => !hide.some((dir) => under(g.project, dir)));
  return {
    day,
    machines: [...new Set(groups.map((g) => g.machine))].sort(),
    projects: groups.map((g) => {
      const time = activeTime(spans(g));
      return {
        path: g.project,
        name: short(g.project),
        machine: g.machine,
        activeMinutes: Math.round(time.ms / 6e4),
        blocks: time.blocks,
        commits: g.commits.map((c) => ({ hash: c.hash, short: c.short, date: c.date, author: c.author, ref: c.ref, subject: c.subject, files: c.files, insertions: c.insertions, deletions: c.deletions, alsoIn: c.alsoIn })),
        sessions: g.sessions.map((s) => ({ tool: s.tool, id: s.id, title: s.title, model: s.model, folder: s.project, start: s.start, end: s.end, toolCalls: s.tool_calls, prompts: s.prompts.length, editedFiles: s.files.length })),
        reports: g.reports.length,
        pending: g.pending.map((p) => ({ file: p.file, status: p.status })),
      };
    }),
  };
}

// The state of every project active in the stale window, as of the end of `day`. Only counts, paths and dates.
// status: active (activity in the last 7 days), idle (within stale.idle), stale (older, but within stale.window)
export function toState(store, day, { idle, window }, { aliases = [], hide = [] } = {}, logs = []) {
  const short = shortener(aliases);
  const end = dayRange(day).to;
  const windowStart = localDate(parseSince(window, end));
  const idleSince = localDate(parseSince(idle, end));
  const weekStart = addDays(day, -6);
  const periods = { '1d': day, '7d': weekStart, '30d': addDays(day, -29) };

  const projects = new Map(watchedOnly(store.activitySince(windowStart, day), hide).map((p) => [p.project, {
    path: p.project,
    name: short(p.project),
    machines: p.machines,
    lastActivity: p.last,
    idleDays: daysBetween(p.last, day),
    status: p.last >= weekStart ? 'active' : p.last >= idleSince ? 'idle' : 'stale',
    counts: Object.fromEntries(Object.keys(periods).map((k) => [k, { commits: 0, sessions: 0, reports: 0, activeMinutes: 0 }])),
    pending: [],
  }]));
  for (let d = periods['30d']; d <= day; d = addDays(d, 1)) {
    for (const g of store.day(d)) {
      const p = projects.get(g.project);
      if (!p) continue;
      const minutes = Math.round(activeTime(spans(g)).ms / 6e4);
      for (const [k, from] of Object.entries(periods)) {
        if (d < from) continue;
        p.counts[k].commits += g.commits.length;
        p.counts[k].sessions += g.sessions.length;
        p.counts[k].reports += g.reports.length;
        p.counts[k].activeMinutes += minutes;
      }
    }
  }
  for (const f of store.pendingUpTo(addDays(day, 1))) projects.get(f.repo)?.pending.push({ file: f.file, status: f.status, machine: f.machine });

  const list = [...projects.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: SCHEMA_VERSION,
    day,
    thresholds: { idle, window },
    machines: [...new Set(list.flatMap((p) => p.machines))].sort(),
    logs,
    summary: Object.fromEntries(['active', 'idle', 'stale'].map((s) => [s, list.filter((p) => p.status === s).length])),
    projects: list,
  };
}
