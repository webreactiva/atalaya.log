process.removeAllListeners('warning');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from '../lib/redact.mjs';
import { parseSince, dayRange, activeTime, duration } from '../lib/time.mjs';
import { parseLog } from '../lib/git.mjs';
import { patchFiles, READERS } from '../lib/sessions.mjs';
import { existingPath, isOwnSession, discoverPrompt } from '../lib/agents.mjs';
import { openStore, toMarkdown } from '../lib/store.mjs';
import { parseCommand, chunks } from '../lib/telegram.mjs';
import { findHome, promptPath } from '../lib/config.mjs';
import { guard, init } from '../lib/init.mjs';

test('redact strips secrets and keeps hashes and plain text', () => {
  const cases = [
    ['use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'use [redacted]'],
    ['token ghp_1234567890abcdefghijABCDEFGHIJ', 'token [redacted]'],
    ['bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', 'bot [redacted]'],
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
  assert.throws(() => init(dir, { pointer, git: false }), /already exists/);

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
