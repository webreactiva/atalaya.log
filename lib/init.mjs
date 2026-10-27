// atalaya init: turns a folder into the atalaya folder (config, .env, prompts, logs, git with a secrets guard)
// and records where it is.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DEFAULTS, POINTER, ROOT, expand, machineLabel } from './config.mjs';
import { redact } from './redact.mjs';
import { DEFAULT_PATHS } from './sessions.mjs';

const ROOT_CANDIDATES = ['~/Sites', '~/code', '~/Code', '~/projects', '~/Projects', '~/dev', '~/src', '~/repos', '~/workspace', '~/Developer'];
const LANGUAGES = { es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ca: 'Catalan', nl: 'Dutch' };

const envTemplate = (machine) => `# Secrets for the "after" commands and the bot. This file is git-ignored and blocked by the pre-commit guard.
# This computer's label: names its folder in activity/ and its section in "machines" (config.json)
ATALAYA_MACHINE=${machine}
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
# SMTP_URL=smtps://smtp.gmail.com:465
# SMTP_USER=
# SMTP_PASS=
# MAIL_FROM=
# MAIL_TO=
`;

const GITIGNORE = `.env
atalaya.db*
workdir/
*.log
`;

// Files that must never reach a commit, whatever .gitignore says (.env.example is fine)
const NEVER = /(^|\/)(\.env(\.(?!example$)[^/]*)?|atalaya\.db[^/]*)$/;

const which = (bin) => {
  try {
    return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
};

// An existing config.json is kept (a clone of your atalaya repo on another machine): the rest is set up around it
export function init(dir, { roots, force, lang = process.env.LANG ?? '', pointer = POINTER, git = true } = {}) {
  const config = join(dir, 'config.json');
  const kept = existsSync(config) && !force;

  const agents = Object.keys(DEFAULTS.agents).map((name) => ({ name, bin: which(DEFAULTS.agents[name].headless[0]), sessions: existsSync(expand(DEFAULT_PATHS[name])) }));
  const writer = agents.find((a) => a.bin);
  const cfg = kept ? JSON.parse(readFileSync(config, 'utf8')) : {
    language: LANGUAGES[lang.slice(0, 2).toLowerCase()] ?? DEFAULTS.language,
    git: { roots: roots ?? ROOT_CANDIDATES.filter((r) => existsSync(expand(r))).slice(0, 3), maxDepth: 3 },
    sources: agents.filter((a) => a.sessions).map((a) => a.name),
    logs: DEFAULTS.logs.map((l) => ({ ...l, agent: writer?.name ?? l.agent })),
    bot: { commands: { daily: 'daily', tldr: 'tldr', roast_me: 'roast', bro: 'bro' } },
    after: [],
    aliases: {},
    hide: [],
  };

  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  if (!kept) writeFileSync(config, JSON.stringify(cfg, null, 2) + '\n');
  // Prompts are copied so they can be edited and versioned with the logs; the bundled ones stay as a fallback
  for (const f of readdirSync(join(ROOT, 'prompts'))) if (!existsSync(join(dir, 'prompts', f))) copyFileSync(join(ROOT, 'prompts', f), join(dir, 'prompts', f));
  if (!existsSync(join(dir, '.env'))) writeFileSync(join(dir, '.env'), envTemplate(machineLabel()), { mode: 0o600 });
  chmodSync(join(dir, '.env'), 0o600);
  // An existing .gitignore is completed, never skipped: committing the logs must never take .env or the store along
  const ignore = join(dir, '.gitignore');
  const have = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  const missing = GITIGNORE.split('\n').filter((l) => l && !have.split('\n').includes(l));
  if (missing.length) appendFileSync(ignore, (have && !have.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  mkdirSync(dirname(pointer), { recursive: true });
  writeFileSync(pointer, dir + '\n');

  // cron doesn't load your shell: PATH must include atalaya, node and the agent that writes the logs
  const path = [...new Set([dirname(process.argv[1]), dirname(process.execPath), writer?.bin && dirname(writer.bin), '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(':');
  return {
    config,
    kept,
    machine: machineLabel(),
    cfg,
    agents,
    writer,
    git: git ? setupGit(dir) : 'skipped',
    cron: `PATH=${path}\n10 0 * * * atalaya daily --date yesterday >> ${join(dir, 'cron.log').replace(homedir(), '$HOME')} 2>&1`,
  };
}

// The folder becomes its own repo with a pre-commit hook running `atalaya guard`. Never touches someone else's repo or hook
export function setupGit(dir) {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let top = null;
  try {
    top = git('rev-parse', '--show-toplevel');
  } catch {
    // not a repo yet
  }
  if (top && realpathSync(top) !== realpathSync(dir)) return `inside the repo ${top}: left alone (no hook installed)`;
  try {
    if (!top) git('init', '-q');
  } catch {
    return 'git not available: no repo created';
  }
  const hooks = git('rev-parse', '--git-path', 'hooks');
  const hook = join(isAbsolute(hooks) ? hooks : join(dir, hooks), 'pre-commit');
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes('atalaya')) return `${top ? 'existing repo' : 'repo created'}; your pre-commit hook was kept, add "atalaya guard" to it`;
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(
    hook,
    // the node that ran init, or the one on PATH if that version is gone (nvm upgrades)
    `#!/bin/sh\n# Installed by atalaya init: refuses commits that would publish .env, the store or a secret\nNODE="${process.execPath}"\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" "${join(ROOT, 'atalaya.mjs')}" guard\n`,
    { mode: 0o755 },
  );
  return `${top ? 'existing repo' : 'repo created'}, pre-commit secrets guard installed`;
}

// atalaya guard: the pre-commit check. Refuses .env, the store, and any staged file the redactor would change
export function guard(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const problems = [];
  for (const file of git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)) {
    if (NEVER.test(file)) {
      problems.push(`${file}: must never be committed`);
      continue;
    }
    const staged = git('show', `:${file}`);
    if (redact(staged) !== staged) problems.push(`${file}: looks like it contains a secret`);
  }
  if (!problems.length) return true;
  console.error(`atalaya guard: commit refused\n${problems.map((p) => `  ${p}`).join('\n')}\nUnstage it (git restore --staged <file>) or remove the secret. For a false positive: git commit --no-verify`);
  process.exitCode = 1;
  return false;
}

// atalaya skill install: links the bundled skills where agents look for skills
export function installSkill() {
  const done = [];
  for (const name of ['atalaya', 'atalaya-stale']) for (const base of [join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')]) {
    const source = join(ROOT, '.agents', 'skills', name);
    const target = join(base, name);
    if (lstatSync(target, { throwIfNoEntry: false })) {
      done.push(`${target} already exists, left alone`);
      continue;
    }
    mkdirSync(base, { recursive: true });
    symlinkSync(source, target);
    done.push(`${target} → ${source}`);
  }
  return done;
}
