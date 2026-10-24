#!/usr/bin/env node
// atalaya: deterministically records what happens in your repos and your AI agent sessions,
// and lets an agent write the logs from that data.
process.removeAllListeners('warning'); // node:sqlite prints an experimental warning on every run

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { expand, findHome, loadConfig, POINTER, promptPath } from './lib/config.mjs';
import { guard, init, installSkill } from './lib/init.mjs';
import { collectGit } from './lib/git.mjs';
import { READERS, DEFAULT_PATHS } from './lib/sessions.mjs';
import { askHeadless, discover, isOwnSession, MARKER } from './lib/agents.mjs';
import { openStore, toMarkdown } from './lib/store.mjs';
import { redact } from './lib/redact.mjs';
import { parseCommand, telegram } from './lib/telegram.mjs';
import { dayRange, localDate, parseSince } from './lib/time.mjs';

const HELP = `atalaya <command> [options]

  init      [dir] [--roots ~/a,~/b] [--force]           Create an atalaya folder (default: the current one)
  collect   [--since 24h | --date YYYY-MM-DD] [--fetch]  Read git and agent sessions into the store
  show      [--date today | --since 7d] [--project txt]  Print what is stored, as Markdown (what the agent receives)
  log       [--date today] [--name log]                  An agent writes the logs configured in "logs"
  daily     [--date today] [--no-after]                  collect + log + the "after" commands
  report    "what got finished" [--source agent]         For agents: record finished work in the current folder
  bot                                                    Telegram bot: /daily, /tldr… [today|yesterday|YYYY-MM-DD]
  discover  [agent ...] [--no-tmux]                      Ask each agent where it stores its sessions
  paths                                                  Show where each source is read from
  skill install                                          Link the atalaya skill into ~/.claude/skills and ~/.agents/skills
  guard                                                  Pre-commit check: refuse staged secrets (installed by init)

atalaya folder: --home <dir> > $ATALAYA_HOME > the last "atalaya init" (${POINTER.replace(homedir(), '~')})`;

const opts = {
  config: { type: 'string' },
  home: { type: 'string' },
  roots: { type: 'string' },
  force: { type: 'boolean' },
  since: { type: 'string' },
  date: { type: 'string' },
  project: { type: 'string' },
  name: { type: 'string' },
  source: { type: 'string' },
  fetch: { type: 'boolean' },
  'no-tmux': { type: 'boolean' },
  'no-after': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// ---------- sources ----------
function sourcePath(cfg, store, name) {
  const configured = cfg.agents[name].path;
  if (configured) return { path: expand(configured), origin: 'config' };
  const discovered = store.paths()[name];
  if (discovered) return { path: discovered, origin: 'discover' };
  return { path: expand(DEFAULT_PATHS[name] ?? ''), origin: 'default' };
}

async function collect(cfg, store, range, { fetch }) {
  const clean = (t) => redact(t, cfg.redact);
  const git = await collectGit({ ...cfg.git, fetch: fetch ?? cfg.git.fetch }, range);
  store.saveGit(git, range, clean);
  const commits = git.projects.reduce((n, p) => n + p.commits.length, 0);
  console.error(`git: ${git.repos.length} repos, ${commits} commits`);

  for (const name of cfg.sources) {
    const { path } = sourcePath(cfg, store, name);
    if (!READERS[name]) {
      console.error(`${name}: there is no reader for this agent`);
      continue;
    }
    if (!existsSync(path)) {
      console.error(`${name}: ${path} not found → atalaya discover ${name}`);
      continue;
    }
    try {
      const sessions = (await READERS[name](path, range.from, range.to)).filter((s) => !isOwnSession(s));
      store.saveSessions(sessions, clean);
      console.error(`${name}: ${sessions.length} session-days`);
    } catch (e) {
      console.error(`${name}: error reading ${path}: ${e.message}`);
    }
  }
}

function rangeFrom(values, fallback = '24h') {
  if (values.date) return dayRange(values.date);
  return { from: parseSince(values.since ?? fallback), to: Date.now() };
}

function exportDays(cfg, store, range, project) {
  return store
    .days(localDate(range.from), localDate(range.to - 1))
    .map((day) => toMarkdown(day, store.day(day, project), cfg.view))
    .join('\n');
}

// ---------- logs written by an agent ----------
async function writeLogs(cfg, store, day, only) {
  // logs with "daily": false are only written on demand (atalaya log --name, the bot)
  const logs = cfg.logs.filter((l) => (only ? l.name === only : l.daily !== false));
  if (!logs.length) throw new Error(only ? `There is no log named "${only}"` : 'No logs configured in "logs"');
  const written = [];
  for (const log of logs) {
    const agent = cfg.agents[log.agent];
    if (!agent) throw new Error(`log ${log.name}: unknown agent "${log.agent}"`);
    const data = toMarkdown(day, store.day(day, log.project), cfg.view);
    const template = await readFile(promptPath(cfg, log.prompt), 'utf8');
    const prompt = `${MARKER} ${template.replaceAll('{date}', day).replaceAll('{language}', log.language ?? cfg.language)}\n\n---\n\n${data}`;
    if (prompt.length > 400_000) throw new Error(`log ${log.name}: ${prompt.length} characters, too long to pass as an argument; narrow it with "project"`);
    console.error(`log ${log.name}: writing with ${log.agent}…`);
    const answer = await askHeadless(agent, prompt);
    if (answer.error) throw new Error(`log ${log.name}: ${log.agent} failed: ${answer.error}`);
    const file = join(cfg.dataDir, 'logs', log.name, `${day}.md`);
    await mkdir(join(cfg.dataDir, 'logs', log.name), { recursive: true });
    await writeFile(file, redact(answer.text, cfg.redact) + '\n'); // the agent may quote something sensitive too
    console.error(`log ${log.name}: ${file}`);
    written.push({ name: log.name, file });
  }
  return written;
}

async function runAfter(cfg, env) {
  for (const cmd of cfg.after) {
    console.error(`after: ${cmd}`);
    const code = await new Promise((res) => spawn('sh', ['-c', cmd], { stdio: 'inherit', cwd: cfg.dataDir, env: { ...process.env, ...env } }).on('close', res));
    if (code !== 0) throw new Error(`after: "${cmd}" exited with code ${code}`);
  }
}

// ---------- Telegram bot ----------
// A day's log: the one already written if it exists (except today, which keeps changing) or a new one. No date: the latest
async function logFor(cfg, store, name, date, onGenerate) {
  const dir = join(cfg.dataDir, 'logs', name);
  if (!date) {
    const last = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().pop();
    if (last) return join(dir, last);
    date = 'yesterday';
  }
  const range = dayRange(date);
  const file = join(dir, `${range.date}.md`);
  if (existsSync(file) && range.date !== localDate(Date.now())) return file;
  await onGenerate(range.date);
  await collect(cfg, store, range, {});
  return (await writeLogs(cfg, store, range.date, name))[0].file;
}

async function runBot(cfg, store) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are missing from .env');
  // Telegram command → log name; by default one per log (Telegram only allows a-z, 0-9 and _)
  const commands = cfg.bot?.commands ?? Object.fromEntries(cfg.logs.map((l) => [l.name.toLowerCase().replace(/\W/g, '_'), l.name]));
  const list = Object.keys(commands).map((c) => `/${c}`).join(' ');
  const help = `Commands: ${list}\nNo date: the latest log. With a date: today, yesterday or YYYY-MM-DD.`;
  const tg = telegram(token);
  await tg.call('setMyCommands', { commands: Object.entries(commands).map(([command, log]) => ({ command, description: `${log} log · today, yesterday or YYYY-MM-DD` })) });
  console.error(`bot: listening for ${list}`);
  await tg.listen(async (msg) => {
    if (String(msg.chat.id) !== String(chat)) return; // only answers your chat
    const cmd = parseCommand(msg.text);
    const name = cmd && commands[cmd.command];
    if (!name) return tg.send(chat, help);
    console.error(`bot: /${cmd.command} ${cmd.arg}`);
    try {
      const file = await logFor(cfg, store, name, cmd.arg || null, (day) => tg.send(chat, `⏳ Writing ${name} for ${day}…`));
      await tg.send(chat, await readFile(file, 'utf8'));
    } catch (e) {
      await tg.send(chat, `⚠️ ${e.message}`);
    }
  });
}

// ---------- init ----------
function runInit(dir, values) {
  const r = init(dir, { roots: values.roots?.split(',').map((x) => x.trim()), force: values.force });
  const tilde = (p) => p.replace(homedir(), '~');
  console.log(`✓ ${tilde(r.config)}`);
  console.log(`  repos in: ${r.cfg.git.roots.join(', ') || '(no folder detected: fill in git.roots)'}`);
  for (const a of r.agents) console.log(`  ${a.name.padEnd(9)} ${a.bin ? 'installed' : '—'}${a.sessions ? ', sessions found' : ''}`);
  console.log(r.writer ? `  logs written by: ${r.writer.name}, in ${r.cfg.language}` : '  ⚠ no agent installed to write the logs (claude, codex, opencode or pi)');
  console.log(`  git: ${r.git}`);
  console.log(`
Next steps:
  1. Review ${tilde(r.config)} (git.roots above all)
  2. atalaya collect --since 7d && atalaya show --date yesterday
  3. atalaya log --date yesterday
  4. Every night (crontab -e):
${r.cron.replace(/^/gm, '     ')}
  5. Optional: secrets in ${tilde(join(dir, '.env'))} for Telegram or email, and "atalaya skill install" so your agents can manage atalaya`);
}

// ---------- main ----------
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, options: opts, allowPositionals: true });
  if (!command || values.help || command === 'help') return console.log(HELP);
  if (command === 'init') return runInit(resolve(positionals[0] ?? '.'), values);
  if (command === 'guard') return guard();
  if (command === 'skill') {
    if (positionals[0] !== 'install') throw new Error('Usage: atalaya skill install');
    return installSkill().forEach((l) => console.log(l));
  }

  const home = findHome(values.home);
  if (!home && !values.config) throw new Error('No atalaya folder found. Run "atalaya init" in the folder where you want your logs');
  const cfg = await loadConfig(values.config ? expand(values.config) : join(home, 'config.json'));
  // Secrets for "after" and the bot (Telegram, SMTP…), never in the config; variables already in the environment win
  if (existsSync(join(cfg.home, '.env'))) process.loadEnvFile(join(cfg.home, '.env'));
  const store = await openStore(join(cfg.dataDir, 'atalaya.db'));
  try {
    switch (command) {
      case 'collect':
        return await collect(cfg, store, rangeFrom(values), values);
      case 'show':
        return console.log(exportDays(cfg, store, rangeFrom(values, values.project ? '7d' : '24h'), values.project) || '_No recorded activity._');
      case 'report': {
        const summary = positionals.join(' ').trim();
        if (!summary) throw new Error('Usage: atalaya report "what got finished and how it ended" [--source claude]');
        const at = new Date().toISOString();
        const id = store.saveReport({ at, project: process.cwd(), source: values.source ?? 'manual', summary }, (t) => redact(t, cfg.redact));
        return console.log(JSON.stringify({ id, at, project: process.cwd() }));
      }
      case 'bot':
        return await runBot(cfg, store);
      case 'paths':
        for (const name of cfg.sources) {
          const { path, origin } = sourcePath(cfg, store, name);
          console.log(`${name.padEnd(10)} ${existsSync(path) ? '✓' : '✗'} ${path} (${origin})`);
        }
        return;
      case 'discover':
        for (const name of positionals.length ? positionals : cfg.sources) {
          if (!cfg.agents[name]) throw new Error(`Unknown agent: ${name}`);
          console.error(`${name}: asking…`);
          const r = await discover(name, cfg.agents[name], { tmux: !values['no-tmux'], workdir: join(cfg.dataDir, 'workdir') });
          if (r.path) {
            store.savePath(name, r);
            console.log(`${name}: ${r.path} (via ${r.method})`);
          } else console.log(`${name}: could not find out → ${r.error}`);
        }
        return;
      case 'log': {
        const { date } = dayRange(values.date ?? 'today');
        return void (await writeLogs(cfg, store, date, values.name));
      }
      case 'daily': {
        const range = dayRange(values.date ?? 'today');
        await collect(cfg, store, range, values);
        const logs = cfg.logs.length ? await writeLogs(cfg, store, range.date) : [];
        // ATALAYA_LOGS in config order, and ATALAYA_LOG_<NAME> to pick one (e.g. the tldr as a text message)
        const byName = Object.fromEntries(logs.map((l) => [`ATALAYA_LOG_${l.name.toUpperCase().replace(/\W/g, '_')}`, l.file]));
        if (!values['no-after']) await runAfter(cfg, { ATALAYA_DATE: range.date, ATALAYA_DATA_DIR: cfg.dataDir, ATALAYA_LOGS: logs.map((l) => l.file).join('\n'), ...byName });
        return;
      }
      default:
        throw new Error(`Unknown command: ${command}\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
