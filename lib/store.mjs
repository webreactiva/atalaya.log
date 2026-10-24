// Deterministic SQLite store: commits by hash, sessions by (agent, id, day). Collecting twice never duplicates,
// and what is stored survives even if an agent deletes its old logs.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { activeTime, duration, hhmm, localDate } from './time.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (path TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY, short TEXT NOT NULL, day TEXT NOT NULL, date TEXT NOT NULL, author TEXT NOT NULL,
  subject TEXT NOT NULL, files INTEGER NOT NULL, insertions INTEGER NOT NULL, deletions INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS commits_day ON commits (day);
CREATE TABLE IF NOT EXISTS commit_refs (hash TEXT NOT NULL, repo TEXT NOT NULL, ref TEXT NOT NULL, branch TEXT, PRIMARY KEY (hash, repo));
CREATE TABLE IF NOT EXISTS sessions (
  tool TEXT NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL, project TEXT, title TEXT, model TEXT,
  start TEXT NOT NULL, end TEXT NOT NULL, tool_calls INTEGER NOT NULL, prompts TEXT NOT NULL, files TEXT NOT NULL,
  PRIMARY KEY (tool, id, day));
CREATE INDEX IF NOT EXISTS sessions_day ON sessions (day);
CREATE TABLE IF NOT EXISTS pending (day TEXT NOT NULL, repo TEXT NOT NULL, file TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (day, repo, file));
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, day TEXT NOT NULL, at TEXT NOT NULL, project TEXT NOT NULL, source TEXT NOT NULL, summary TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS reports_day ON reports (day);
CREATE TABLE IF NOT EXISTS agent_paths (agent TEXT PRIMARY KEY, path TEXT NOT NULL, method TEXT NOT NULL, answer TEXT, checked_at TEXT NOT NULL);
`;

export async function openStore(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 10000'); // the bot and cron may write at the same time
  db.exec(SCHEMA);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
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
    const repo = this.db.prepare('INSERT INTO repos VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET seen_at = excluded.seen_at');
    const commit = this.db.prepare(`INSERT INTO commits VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET
      subject = excluded.subject, files = excluded.files, insertions = excluded.insertions, deletions = excluded.deletions`);
    const ref = this.db.prepare('INSERT INTO commit_refs VALUES (?, ?, ?, ?) ON CONFLICT(hash, repo) DO UPDATE SET ref = excluded.ref, branch = excluded.branch');
    const delPending = this.db.prepare('DELETE FROM pending WHERE day = ?');
    const pend = this.db.prepare('INSERT OR REPLACE INTO pending VALUES (?, ?, ?, ?)');
    this.tx(() => {
      for (const r of repos) repo.run(r, now);
      for (const p of projects) {
        for (const c of p.commits) {
          commit.run(c.hash, c.short, localDate(Date.parse(c.date)), c.date, clean(c.author), clean(c.subject), c.files, c.insertions, c.deletions);
          ref.run(c.hash, p.repo, c.ref, p.branch);
        }
      }
      // Uncommitted changes are a snapshot of "now": replaced as a whole for today
      if (to >= Date.now() - 60_000) {
        const today = localDate(Date.now());
        delPending.run(today);
        for (const p of projects) for (const f of p.pending) pend.run(today, p.repo, clean(f.file), f.status);
      }
    });
  }

  saveSessions(sessions, clean) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.tx(() => {
      for (const s of sessions) {
        stmt.run(s.tool, s.id, s.day, s.project, clean(s.title), s.model, s.start, s.end, s.toolCalls,
          JSON.stringify(s.prompts.map((t) => clean(t))), JSON.stringify(s.files.map((t) => clean(t))));
      }
    });
  }

  // What an agent says it finished (atalaya report). The id is a hash of the content: repeating it doesn't duplicate
  saveReport({ at, project, source, summary }, clean) {
    const text = clean(summary);
    const id = createHash('sha256').update([at, project, source, text].join('\0')).digest('hex').slice(0, 16);
    this.db.prepare('INSERT OR IGNORE INTO reports VALUES (?, ?, ?, ?, ?, ?)').run(id, localDate(Date.parse(at)), at, project, source, text);
    return id;
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

  // Everything for one day grouped by project folder, in a stable order
  day(day, project) {
    const repos = this.db.prepare('SELECT path FROM repos').all().map((r) => r.path).sort((a, b) => b.length - a.length);
    const owner = (dir) => (dir && repos.find((r) => dir === r || dir.startsWith(r + '/'))) ?? dir ?? '(no folder)';
    const groups = new Map();
    const group = (key) => {
      if (!groups.has(key)) groups.set(key, { project: key, commits: [], sessions: [], reports: [], pending: [] });
      return groups.get(key);
    };

    const refs = this.db.prepare('SELECT repo, ref FROM commit_refs WHERE hash = ? ORDER BY repo');
    // dates carry the committer's time zone: sort by instant, not by text
    const commits = this.db.prepare('SELECT * FROM commits WHERE day = ?').all(day);
    commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.hash.localeCompare(b.hash));
    for (const c of commits) {
      const [first, ...others] = refs.all(c.hash); // the same commit in several clones is listed once
      group(first.repo).commits.push({ ...c, ref: first.ref, alsoIn: others.map((o) => o.repo) });
    }
    for (const s of this.db.prepare('SELECT * FROM sessions WHERE day = ? ORDER BY start, tool, id').all(day)) {
      group(owner(s.project)).sessions.push({ ...s, prompts: JSON.parse(s.prompts), files: JSON.parse(s.files) });
    }
    for (const r of this.db.prepare('SELECT * FROM reports WHERE day = ? ORDER BY at, id').all(day)) group(owner(r.project)).reports.push(r);
    for (const p of this.db.prepare('SELECT * FROM pending WHERE day = ? ORDER BY repo, file').all(day)) group(p.repo).pending.push(p);

    return [...groups.values()]
      .filter((g) => !project || g.project.includes(project))
      .sort((a, b) => a.project.localeCompare(b.project));
  }
}

// ---------- Markdown export: what the agent receives ----------
const under = (path, dir) => path === dir || path.startsWith(dir + '/');

// view: { aliases: [[path, name]] longest first, hide: [paths] }. Only changes what is shown, not what is stored
export function toMarkdown(day, allGroups, { aliases = [], hide = [] } = {}) {
  const short = (p) => {
    const hit = aliases.find(([dir]) => under(p, dir));
    return hit ? hit[1] + p.slice(hit[0].length) : p.replace(homedir(), '~');
  };
  const rel = (file, project) => (file.startsWith(project + '/') ? file.slice(project.length + 1) : short(file));
  const groups = allGroups.filter((g) => !hide.some((dir) => under(g.project, dir)));
  const out = [`# Recorded activity · ${day}`, ''];
  if (!groups.length) out.push('_No recorded activity._', '');
  for (const g of groups) {
    const spans = [
      ...g.commits.map((c) => [Date.parse(c.date), Date.parse(c.date)]),
      ...g.sessions.map((s) => [Date.parse(s.start), Date.parse(s.end)]),
      ...g.reports.map((r) => [Date.parse(r.at), Date.parse(r.at)]),
    ];
    const time = activeTime(spans);
    out.push(`## ${short(g.project)}`, '');
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
