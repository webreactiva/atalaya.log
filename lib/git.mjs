// Git activity of every repo under the configured roots.
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (cwd, args) => run('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout);

export const REFS = { local: '--branches', remote: '--remotes', all: '--all' };
const SEP = '\x1f';
const REC = '\x1e';

export async function findRepos(dir, cfg, depth = 0, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // no permission or deleted: skipped
  }
  // .git can be a folder or a file (worktrees/submodules)
  if (entries.some((e) => e.name === '.git')) out.push(dir);
  if (depth >= cfg.maxDepth) return out;
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !cfg.ignore.includes(e.name))
      .map((e) => findRepos(join(dir, e.name), cfg, depth + 1, out)),
  );
  return out;
}

export function parseLog(out) {
  return out
    .split(REC)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [head, ...rest] = chunk.trim().split('\n');
      const [hash, short, date, author, ref, subject] = head.split(SEP);
      const stat = rest.join(' ');
      const n = (re) => Number(stat.match(re)?.[1] ?? 0);
      return {
        hash, short, date, author, ref: ref.replace(/^refs\/(heads|remotes)\//, ''), subject,
        files: n(/(\d+) files? changed/),
        insertions: n(/(\d+) insertions?\(\+\)/),
        deletions: n(/(\d+) deletions?\(-\)/),
      };
    });
}

// A deleted file has no mtime: use the nearest existing folder's, which changes on deletion
async function mtimeOf(repo, file) {
  for (let p = file; ; p = dirname(p)) {
    try {
      return (await stat(join(repo, p))).mtimeMs;
    } catch {
      if (p === '.' || p === '/') return 0;
    }
  }
}

async function inspect(repo, cfg, from, to) {
  // --source + %S: the ref through which git reached the commit
  const logArgs = ['log', REFS[cfg.refs], '--source', '--no-merges', `--since=@${Math.floor(from / 1000)}`, `--until=@${Math.floor(to / 1000)}`,
    `--format=${REC}%H${SEP}%h${SEP}%aI${SEP}%an${SEP}%S${SEP}%s`, '--shortstat'];
  for (const a of cfg.authors) logArgs.push(`--author=${a}`); // several --author: git ORs them

  if (cfg.fetch) await git(repo, ['fetch', '--all', '--quiet']).catch(() => {}); // offline or no remote: carry on with what is there
  const includePending = to >= Date.now() - 60_000; // uncommitted state only exists "now"
  const [log, branch, status] = await Promise.all([
    git(repo, logArgs).catch(() => ''), // repo with no commits
    git(repo, ['branch', '--show-current']).catch(() => ''),
    includePending ? git(repo, ['status', '--porcelain']).catch(() => '') : '',
  ]);

  // Only uncommitted changes touched inside the window count, not old leftovers
  const pending = [];
  for (const line of status.split('\n').filter(Boolean)) {
    const file = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
    if ((await mtimeOf(repo, file)) >= from) pending.push({ status: line.slice(0, 2).trim(), file });
  }

  const commits = parseLog(log);
  if (!commits.length && !pending.length) return null;
  return { repo, branch: branch.trim() || '(detached)', commits, pending };
}

async function pool(items, limit, fn) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) results.push(await fn(items[i++]));
    }),
  );
  return results.filter(Boolean);
}

export async function collectGit(cfg, { from, to = Date.now() }) {
  if (!REFS[cfg.refs]) throw new Error(`refs debe ser ${Object.keys(REFS).join('|')}, no "${cfg.refs}"`);
  const repos = [...new Set((await Promise.all(cfg.roots.map((r) => findRepos(r, cfg)))).flat())].sort();
  const projects = (await pool(repos, cfg.concurrency, (r) => inspect(r, cfg, from, to)))
    .sort((a, b) => (b.commits[0]?.date ?? '').localeCompare(a.commits[0]?.date ?? ''));
  return { repos, projects };
}
