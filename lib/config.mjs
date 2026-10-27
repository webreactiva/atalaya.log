import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

// The atalaya folder (config.json, .env, prompts, logs, store) is created by `atalaya init` wherever it runs.
// To find it from anywhere (cron, the bot, `report` in another project): --home > ATALAYA_HOME > what init recorded
export const POINTER = join(homedir(), '.config', 'atalaya', 'home');
export function findHome(flag) {
  const home = flag ?? process.env.ATALAYA_HOME ?? (existsSync(POINTER) ? readFileSync(POINTER, 'utf8').trim() : null);
  return home ? expand(home) : null;
}

// This computer's label: ATALAYA_MACHINE (in its .env, which is never shared) or its short host name.
// It names its folder in activity/ and its section in "machines", so it must be safe as a folder name
export function machineLabel(env = process.env) {
  const label = (env.ATALAYA_MACHINE || hostname().split('.')[0]).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return label || 'local';
}

// A prompt in the atalaya folder wins over the bundled one with the same name
export const promptPath = (cfg, p) => (isAbsolute(p) ? p : [join(cfg.home, p), join(ROOT, p)].find(existsSync) ?? join(cfg.home, p));

export const DEFAULTS = {
  language: 'English', // replaces {language} in the prompts: the language the logs are written in
  git: { roots: ['~/Sites'], maxDepth: 3, ignore: ['node_modules'], concurrency: 8, refs: 'all', fetch: false, authors: [] },
  sources: ['claude', 'codex', 'opencode', 'pi'],
  agents: {
    claude: { headless: ['claude', '-p', '{prompt}'], interactive: ['claude'] },
    codex: { headless: ['codex', 'exec', '--skip-git-repo-check', '{prompt}'], interactive: ['codex', '-c', 'check_for_update_on_startup=false'] },
    opencode: { headless: ['opencode', 'run', '{prompt}'], interactive: ['opencode'] },
    pi: { headless: ['pi', '-p', '{prompt}'], interactive: ['pi'] },
  },
  // Only daily is written by the nightly "daily"; the rest are on demand (atalaya log --name, the bot) or enabled with "daily": true
  logs: [
    { name: 'daily', agent: 'claude', prompt: 'prompts/daily.md' },
    { name: 'tldr', agent: 'claude', prompt: 'prompts/tldr.md', daily: false },
    { name: 'roast', agent: 'claude', prompt: 'prompts/roast.md', daily: false },
    { name: 'bro', agent: 'claude', prompt: 'prompts/bro.md', daily: false },
  ],
  before: [],
  after: [],
  redact: [],
  aliases: {},
  hide: [],
};

export async function loadConfig(path) {
  let file;
  try {
    file = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? `${path} does not exist. Run "atalaya init" in the folder where you want your logs` : `Invalid config in ${path}: ${e.message}`);
  }
  // "machines": { "<label>": { ...overrides } } lets each computer change what it reads (git.roots, sources, logs…)
  const machine = machineLabel();
  const own = file.machines?.[machine] ?? {};
  file = { ...file, ...own, git: { ...file.git, ...own.git }, agents: { ...file.agents, ...own.agents } };
  const agents = { ...DEFAULTS.agents };
  for (const [k, v] of Object.entries(file.agents ?? {})) agents[k] = { ...agents[k], ...v };
  const cfg = { ...DEFAULTS, ...file, git: { ...DEFAULTS.git, ...file.git }, agents };
  cfg.machine = machine;
  cfg.home = dirname(resolve(path));
  cfg.dataDir = cfg.dataDir ? expand(cfg.dataDir) : cfg.home; // store and logs; next to the config by default
  cfg.git.roots = cfg.git.roots.map(expand);
  cfg.redact = cfg.redact.map((r) => new RegExp(r, 'g'));
  cfg.view = {
    aliases: Object.entries(cfg.aliases).map(([dir, name]) => [expand(dir), name]).sort((a, b) => b[0].length - a[0].length),
    hide: cfg.hide.map(expand),
  };
  for (const s of cfg.sources) if (!cfg.agents[s]) throw new Error(`Unknown source: ${s}`);
  return cfg;
}
