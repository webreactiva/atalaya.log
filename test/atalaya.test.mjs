process.removeAllListeners('warning');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from '../lib/redact.mjs';
import { parseSince, dayRange, activeTime, duration } from '../lib/time.mjs';
import { parseLog } from '../lib/git.mjs';
import { patchFiles, READERS } from '../lib/sessions.mjs';
import { existingPath, isOwnSession, discoverPrompt } from '../lib/agents.mjs';
import { openStore, toDayJson, toMarkdown, toStaleJson, toStaleMarkdown, toState } from '../lib/store.mjs';
import { parseCommand, chunks } from '../lib/telegram.mjs';
import { findHome, promptPath } from '../lib/config.mjs';
import { guard, init } from '../lib/init.mjs';

test('redact strips secrets and keeps hashes and plain text', () => {
  const cases = [
    ['use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'use [redacted]'],
    ['token ghp_1234567890abcdefghijABCDEFGHIJ', 'token [redacted]'],
    ['bot 123456789:' + 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', 'bot [redacted]'], // split so secret scanners don't flag a fake token
    ['Authorization: Bearer abc.def.ghi12345', 'Authorization: Bearer [redacted]'],
    ['DB_PASSWORD=supersecret123', 'DB_PASSWORD=[redacted]'],
    ['api_key: "x9y8z7w6v5"', 'api_key: [redacted]'],
    ['git clone https://dani:hunter22@github.com/x', 'git clone [redacted]github.com/x'],
    ['AKIAIOSFODNN7EXAMPLE in the config', '[redacted] in the config'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  const safe = 'fix(mcp): cap writes per user · 259644e4c296c0b983e1f943af2d752edae9e3c3';
  assert.equal(redact(safe), safe);
  assert.equal(redact('the bot token lives in .env'), 'the bot token lives in .env');
  assert.equal(redact('Save tokens: custom commands'), 'Save tokens: custom commands');
  const path = '/Users/you/Sites/lab/weather-app/weather-flow-v2/openspec/changes/archive/2026-05-18-add-upstream-call-timeouts/design.md';
  assert.equal(redact(path), path);
  assert.equal(redact('key AbCdEf0123456789GhIjKl0123456789MnOpQr99 loose'), 'key [redacted] loose');
  assert.equal(redact(redact('DB_PASSWORD=supersecret123')), 'DB_PASSWORD=[redacted]'); // idempotent, so the guard accepts logs
});

test('parseSince and dayRange', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  assert.equal(parseSince('24h', now), now - 864e5);
  assert.equal(parseSince('90m', now), now - 90 * 6e4);
  assert.throws(() => parseSince('potato'));
  const r = dayRange('2026-10-20');
  assert.equal(r.date, '2026-10-20');
  assert.equal(new Date(r.from).getHours(), 0);
  assert.ok(r.to - r.from >= 23 * 36e5 && r.to - r.from <= 25 * 36e5); // DST changes
  assert.equal(dayRange('yesterday', new Date(2026, 9, 24, 10)).date, '2026-10-23');
  assert.throws(() => dayRange('ayer'));
});

test('activeTime merges marks less than 60 min apart and adds 5 min per block', () => {
  const m = 6e4;
  // 10:00–10:30 and a commit at 11:20 (50 min later) are one block; 13:00 is another
  const r = activeTime([[600 * m, 630 * m], [680 * m, 680 * m], [780 * m, 780 * m]]);
  assert.deepEqual(r, { ms: (80 + 5 + 5) * m, blocks: 2 });
  assert.deepEqual(activeTime([]), { ms: 0, blocks: 0 });
  assert.equal(duration(95 * m), '1 h 35 min');
  assert.equal(duration(120 * m), '2 h');
});

test('parseLog and patchFiles', () => {
  const out = '\x1eaaaa1111\x1faaaa111\x1f2026-10-24T10:00:00+02:00\x1fDaniel\x1frefs/remotes/origin/main\x1ffeat: something\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\n';
  assert.deepEqual(parseLog(out)[0], { hash: 'aaaa1111', short: 'aaaa111', date: '2026-10-24T10:00:00+02:00', author: 'Daniel', ref: 'origin/main', subject: 'feat: something', files: 3, insertions: 10, deletions: 2 });
  assert.deepEqual(patchFiles('*** Update File: a.php\n*** Add File: b.md\n*** Delete File: c.txt'), ['a.php', 'b.md', 'c.txt']);
});

test('readPi reads prompts, model and edited files as absolute paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'atalaya-pi-'));
  mkdirSync(join(root, '--r-a--'));
  const at = (min) => new Date(Date.UTC(2026, 9, 20, 10, min)).toISOString();
  const rows = [
    { type: 'session', id: 'p1', timestamp: at(0), cwd: '/r/a' },
    { type: 'model_change', timestamp: at(0), modelId: 'gpt-5.5' },
    { type: 'message', timestamp: at(1), message: { role: 'system', content: '' } },
    { type: 'message', timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'fix the login' }] } },
    { type: 'message', timestamp: at(2), message: { role: 'assistant', content: [
      { type: 'toolCall', name: 'edit', arguments: { path: 'src/login.js' } }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] } },
  ];
  writeFileSync(join(root, '--r-a--', 's.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  const [s] = await READERS.pi(root, 0, Date.UTC(2027, 0));
  assert.deepEqual({ id: s.id, project: s.project, model: s.model, prompts: s.prompts, files: s.files, toolCalls: s.toolCalls },
    { id: 'p1', project: '/r/a', model: 'gpt-5.5', prompts: ['fix the login'], files: ['/r/a/src/login.js'], toolCalls: 2 });
});

test('existingPath only accepts real paths outside tmp', () => {
  assert.equal(existingPath('They are in `/usr/bin`.'), '/usr/bin');
  assert.equal(existingPath('/does/not/exist'), null);
  assert.ok(isOwnSession({ prompts: [discoverPrompt('codex')] }));
  assert.ok(isOwnSession({ prompts: ['"' + discoverPrompt('opencode') + '"'] })); // opencode stores it quoted
  assert.ok(!isOwnSession({ prompts: ['hello [atalaya]'] }));
});

test('the store is idempotent, dedupes clones and redacts', async () => {
  const store = await openStore(':memory:');
  const commit = { hash: 'f'.repeat(40), short: 'fffffff', date: '2026-10-20T10:00:00+02:00', author: 'Daniel', ref: 'main', subject: 'feat: with sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', files: 1, insertions: 2, deletions: 0 };
  const git = { repos: ['/r/a', '/r/b'], projects: [{ repo: '/r/a', branch: 'main', commits: [commit], pending: [] }, { repo: '/r/b', branch: 'main', commits: [commit], pending: [] }] };
  const session = { tool: 'claude', id: 's1', day: '2026-10-20', project: '/r/a/sub', title: 'T', model: 'm', start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T09:00:00.000Z', toolCalls: 3, prompts: ['hello'], files: ['/r/a/x.js'] };
  const range = { from: 0, to: 0 };
  const render = () => toMarkdown('2026-10-20', store.day('2026-10-20'));

  store.saveGit(git, range, redact);
  store.saveSessions([session], redact);
  const first = createHash('sha256').update(render()).digest('hex');
  store.saveGit(git, range, redact);
  store.saveSessions([session], redact);
  assert.equal(createHash('sha256').update(render()).digest('hex'), first);

  const md = render();
  assert.equal(md.match(/`fffffff`/g).length, 1); // a commit in two clones is listed once
  assert.match(md, /also in \/r\/b/);
  assert.match(md, /^## \/r\/a$/m); // the /r/a/sub session lands in its repo
  assert.doesNotMatch(md, /sk-ant/);
  assert.deepEqual(store.days('2026-10-01', '2026-10-31'), ['2026-10-20']);

  const report = { at: '2026-10-20T09:30:00.000Z', project: '/r/a/sub', source: 'claude', summary: 'Login done; key ghp_1234567890abcdefghijABCDEFGHIJ' };
  assert.equal(store.saveReport(report, redact), store.saveReport(report, redact)); // same id, no duplicate
  const withReport = render();
  assert.equal(withReport.match(/Login done/g).length, 1);
  assert.doesNotMatch(withReport, /ghp_/);
  assert.match(withReport, /Estimated time: 1 h 35 min in 1 block/); // 08:00 commit → 09:30 report, +5

  const view = { aliases: [['/r/a', '/lab']], hide: ['/r/b'] };
  const viewed = toMarkdown('2026-10-20', store.day('2026-10-20'), view);
  assert.match(viewed, /^## \/lab$/m);
  assert.match(viewed, /Folder: `\/lab\/sub`/);
  assert.equal(toMarkdown('2026-10-20', store.day('2026-10-20'), { hide: ['/r'] }).includes('## '), false); // hides subfolders
  store.close();
});

test('machines export their day and import the others, without duplicates', async () => {
  const day = '2026-10-20';
  const commit = { hash: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-10-20T10:00:00+02:00', author: 'Daniel', ref: 'main', subject: 'feat: shared', files: 1, insertions: 1, deletions: 0 };
  const session = (id) => ({ tool: 'claude', id, day, project: '/r/a', title: id, model: 'm', start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T08:30:00.000Z', toolCalls: 1, prompts: ['hi'], files: [] });
  const laptop = await openStore(':memory:', 'laptop');
  const office = await openStore(':memory:', 'office');
  for (const [store, id] of [[laptop, 'from-laptop'], [office, 'from-office']]) {
    store.saveGit({ repos: ['/r/a'], projects: [{ repo: '/r/a', branch: 'main', commits: [commit], pending: [] }] }, { from: 0, to: 0 }, redact);
    store.saveSessions([session(id)], redact);
  }
  office.saveReport({ at: '2026-10-20T09:00:00.000Z', project: '/r/a', source: 'claude', summary: 'done, key ghp_1234567890abcdefghijABCDEFGHIJ' }, (t) => t); // a secret left in by the other side

  const exported = office.exportDay(day);
  assert.equal(JSON.stringify(office.exportDay(day)), JSON.stringify(exported)); // same bytes every time
  assert.equal(office.exportDay('2026-10-21'), null);
  assert.equal(office.exportDay(day, ['/r']), null); // hidden folders never leave the machine
  laptop.importDay('office', JSON.parse(JSON.stringify(exported)), redact);
  laptop.importDay('office', JSON.parse(JSON.stringify(exported)), redact);

  const md = toMarkdown(day, laptop.day(day));
  assert.match(md, /^Machines: laptop, office$/m);
  assert.match(md, /^## \/r\/a · laptop$/m);
  assert.match(md, /^## \/r\/a · office$/m);
  assert.equal(md.match(/`aaaaaaa`/g).length, 1); // the same commit on two machines is listed once
  assert.equal(md.match(/Session: `from-office`/g).length, 1); // imported twice, stored once
  assert.doesNotMatch(md, /ghp_/); // imported files are redacted again
  assert.deepEqual(laptop.exportDay(day).commits.map((c) => c.short), ['aaaaaaa']); // importing didn't take its own commit away
  assert.doesNotMatch(toMarkdown(day, office.day(day)), /Machines:/); // a single machine looks as before
  laptop.close();
  office.close();
});

test('stale lists projects active in the window but idle lately', async () => {
  const store = await openStore(':memory:', 'laptop');
  const commit = (hash, date) => ({ hash: hash.repeat(40), short: hash.repeat(7), date, author: 'D', ref: 'main', subject: 's', files: 1, insertions: 1, deletions: 0 });
  store.saveGit({ repos: ['/r/old', '/r/live'], projects: [
    { repo: '/r/old', branch: 'main', commits: [commit('a', '2026-08-01T10:00:00Z'), commit('b', '2026-08-03T10:00:00Z')], pending: [] },
    { repo: '/r/live', branch: 'main', commits: [commit('c', '2026-08-01T10:00:00Z')], pending: [] },
  ] }, { from: 0, to: 0 }, redact);
  store.saveSessions([{ tool: 'claude', id: 's', day: '2026-10-20', project: '/r/live/sub', title: 't', model: 'm', start: '2026-10-20T08:00:00Z', end: '2026-10-20T09:00:00Z', toolCalls: 1, prompts: [], files: [] }], redact);
  const projects = store.activitySince('2026-07-29');
  assert.deepEqual(projects.map((p) => [p.project, p.last, p.commits, p.sessions]), [['/r/old', '2026-08-03', 2, 0], ['/r/live', '2026-10-20', 1, 1]]);
  const md = toStaleMarkdown(projects, { today: '2026-10-27', idleSince: '2026-09-27', idle: '30d', window: '90d' });
  assert.match(md, /1 of 2 projects/);
  assert.match(md, /^\| \/r\/old \| 2026-08-03 \| 85 days \| 2 \| 0 \|$/m);
  assert.doesNotMatch(md, /\/r\/live/); // its agent session in a subfolder keeps it alive
  assert.match(toStaleMarkdown(projects, { today: '2026-10-27', idleSince: '2026-09-27', idle: '30d', window: '90d' }, { hide: ['/r/old'] }), /Nothing stale/);
  store.close();
});

test('temp folders are one project left out of stale, and non-repo subfolders join their parent', async () => {
  const store = await openStore(':memory:', 'laptop');
  store.saveGit({ repos: ['/code/api'], projects: [] }, { from: 0, to: 0 }, redact);
  const session = (id, project) => ({ tool: 'claude', id, day: '2026-08-10', project, title: id, model: 'm', start: '2026-08-10T08:00:00Z', end: '2026-08-10T09:00:00Z', toolCalls: 1, prompts: [], files: [] });
  store.saveSessions([
    session('tmp-root', '/private/tmp'), session('tmp-sub', '/private/tmp/exp/1'), session('folders', '/var/folders/xy/T/run'),
    session('parent', '/live/skills'), session('child', '/live/skills/a'), session('grandchild', '/live/skills/b/c'),
    session('workspace', '/code'), session('loose', '/code/sketch'), session('home', homedir()), session('in-home', join(homedir(), 'notes')),
  ], redact);
  const projects = store.activitySince('2026-07-29');
  assert.deepEqual(projects.map((p) => [p.project, p.sessions]), [
    ['/code', 1], ['/code/sketch', 1], // /code holds a repo: a workspace, not a project that swallows its folders
    ['/live/skills', 3], ['/private/tmp', 2], ['/var/folders', 1],
    [homedir(), 1], [join(homedir(), 'notes'), 1], // home never swallows anything
  ].sort((a, b) => a[0].localeCompare(b[0])));
  const md = toStaleMarkdown(projects, { today: '2026-10-27', idleSince: '2026-09-27', idle: '30d', window: '90d' });
  assert.doesNotMatch(md, /tmp|var\/folders/);
  assert.match(toMarkdown('2026-08-10', store.day('2026-08-10')), /^## \/live\/skills$[\s\S]*Folder: `\/live\/skills\/b\/c`/m); // the log still says where
  store.close();
});

test('JSON: day, stale and state carry counts and paths, never prompts, in stable bytes', async () => {
  const store = await openStore(':memory:', 'laptop');
  const commit = (hash, date) => ({ hash: hash.repeat(40), short: hash.repeat(7), date, author: 'D', ref: 'main', subject: 's', files: 1, insertions: 1, deletions: 0 });
  const session = (id, day, project) => ({ tool: 'claude', id, day, project, title: 't', model: 'm', start: `${day}T08:00:00Z`, end: `${day}T09:00:00Z`, toolCalls: 2, prompts: ['secret plan'], files: ['/r/x.js'] });
  store.saveGit({ repos: ['/r/old', '/r/live', '/r/hot', '/r/hidden'], projects: [
    { repo: '/r/old', branch: 'main', commits: [commit('a', '2026-08-03T10:00:00Z')], pending: [] },
    { repo: '/r/hot', branch: 'main', commits: [commit('b', '2026-10-27T10:00:00Z'), commit('c', '2026-10-22T10:00:00Z'), commit('d', '2026-10-29T10:00:00Z')], pending: [] },
    { repo: '/r/hidden', branch: 'main', commits: [commit('e', '2026-10-27T11:00:00Z')], pending: [] },
  ] }, { from: 0, to: 0 }, redact);
  store.saveSessions([session('s1', '2026-10-20', '/r/live/sub'), session('s2', '2026-10-27', '/r/hot')], redact);
  store.importDay('laptop', { day: '2026-10-28', pending: [{ day: '2026-10-28', repo: '/r/hot', file: 'a.js', status: 'M' }] }, redact);

  const state = toState(store, '2026-10-27', { idle: '30d', window: '90d' }, { hide: ['/r/hidden'] }, [{ name: 'daily', file: 'logs/daily/2026-10-27.md' }]);
  assert.equal(JSON.stringify(toState(store, '2026-10-27', { idle: '30d', window: '90d' }, { hide: ['/r/hidden'] }, [{ name: 'daily', file: 'logs/daily/2026-10-27.md' }])), JSON.stringify(state));
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.summary, { active: 1, idle: 1, stale: 1 });
  assert.deepEqual(state.projects.map((p) => [p.path, p.status, p.lastActivity, p.idleDays]), [['/r/hot', 'active', '2026-10-27', 0], ['/r/live', 'idle', '2026-10-20', 7], ['/r/old', 'stale', '2026-08-03', 85]]);
  const hot = state.projects[0];
  assert.deepEqual(hot.counts['1d'], { commits: 1, sessions: 1, reports: 0, activeMinutes: 125 }); // 08:00 → 10:00 + 5
  assert.equal(hot.counts['7d'].commits, 2); // the 10-29 commit is after the day
  assert.deepEqual(hot.pending, [{ file: 'a.js', status: 'M', machine: 'laptop' }]); // the snapshot taken just after midnight
  assert.doesNotMatch(JSON.stringify(state), /secret plan|hidden/);

  const day = toDayJson('2026-10-27', store.day('2026-10-27'));
  assert.deepEqual(day.projects.map((p) => p.path), ['/r/hidden', '/r/hot']);
  assert.deepEqual(day.projects[1].sessions[0], { tool: 'claude', id: 's2', title: 't', model: 'm', folder: '/r/hot', start: '2026-10-27T08:00:00Z', end: '2026-10-27T09:00:00Z', toolCalls: 2, prompts: 1, editedFiles: 1 });
  assert.doesNotMatch(JSON.stringify(day), /secret plan/);

  const stale = toStaleJson(store.activitySince('2026-07-29'), { today: '2026-10-27', idleSince: '2026-09-27', idle: '30d', window: '90d' });
  assert.deepEqual(stale.stale, [{ path: '/r/old', name: '/r/old', lastActivity: '2026-08-03', idleDays: 85, commits: 1, sessionDays: 0, machines: ['laptop'] }]);
  store.close();
});

test('Telegram bot commands', () => {
  assert.deepEqual(parseCommand('/roast_me@jarvis_bot 2026-10-20'), { command: 'roast_me', arg: '2026-10-20' });
  assert.deepEqual(parseCommand('/TLDR'), { command: 'tldr', arg: '' });
  assert.equal(parseCommand('hello'), null);
  const parts = chunks(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(90)].join('\n'), 40);
  assert.ok(parts.every((p) => p.length <= 40));
  assert.equal(parts.join('').replaceAll('\n', ''), 'a'.repeat(30) + 'b'.repeat(30) + 'c'.repeat(90));
});

test('init creates the folder, completes an existing .gitignore and records the folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atalaya-home-'));
  const pointer = join(dir, 'pointer', 'home'); // never the user's real pointer
  writeFileSync(join(dir, '.gitignore'), 'node_modules');
  const r = init(dir, { roots: ['/r'], pointer, lang: 'es_ES.UTF-8', git: false });
  const ignore = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n');
  for (const l of ['node_modules', '.env', 'atalaya.db*']) assert.ok(ignore.includes(l), l);
  init(dir, { force: true, pointer, lang: 'C', git: false });
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').filter((l) => l === '.env').length, 1); // idempotent
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  assert.equal(readFileSync(pointer, 'utf8').trim(), dir);
  assert.equal(r.cfg.language, 'Spanish');
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).language, 'English');
  assert.ok(existsSync(join(dir, 'prompts', 'tldr.md')));
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^ATALAYA_MACHINE=[a-z0-9_-]+$/m);
  writeFileSync(join(dir, 'config.json'), '{"language":"French"}\n'); // a clone of the atalaya repo
  rmSync(join(dir, '.env'));
  assert.equal(init(dir, { pointer, git: false }).kept, true);
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"language":"French"}\n');
  assert.ok(existsSync(join(dir, '.env')));

  const old = process.env.ATALAYA_HOME;
  process.env.ATALAYA_HOME = dir;
  assert.equal(findHome(), dir);
  assert.equal(findHome('/other'), '/other'); // --home wins
  if (old === undefined) delete process.env.ATALAYA_HOME;
  else process.env.ATALAYA_HOME = old;
  writeFileSync(join(dir, 'prompts', 'tldr.md'), 'mine');
  assert.equal(promptPath({ home: dir }, 'prompts/tldr.md'), join(dir, 'prompts', 'tldr.md'));
  assert.notEqual(promptPath({ home: '/nowhere' }, 'prompts/tldr.md'), '/nowhere/prompts/tldr.md'); // falls back to the bundled one
});

test('init makes the folder a repo whose pre-commit guard refuses secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atalaya-git-'));
  const r = init(dir, { roots: ['/r'], pointer: join(dir, 'pointer') });
  assert.match(r.git, /repo created, pre-commit secrets guard installed/);
  const hook = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.match(hook, /atalaya\.mjs" guard/);
  assert.ok(statSync(join(dir, '.git', 'hooks', 'pre-commit')).mode & 0o100);

  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  const quiet = () => {
    const err = console.error;
    console.error = () => {};
    try {
      return guard(dir);
    } finally {
      console.error = err;
      process.exitCode = 0;
    }
  };
  git('add', 'config.json', 'prompts');
  assert.equal(quiet(), true);
  writeFileSync(join(dir, 'logs', 'leak.md'), 'token ghp_1234567890abcdefghijABCDEFGHIJ\n');
  git('add', 'logs/leak.md');
  assert.equal(quiet(), false);
  git('rm', '-q', '--cached', 'logs/leak.md');
  git('add', '-f', '.env');
  assert.equal(quiet(), false); // even forced past .gitignore
});
