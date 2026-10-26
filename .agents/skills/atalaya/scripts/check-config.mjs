#!/usr/bin/env node
// Validates config.json after an edit: that it loads, that every log and bot command points at something that exists,
// and that no secret slipped in (those belong in .env). Exits with code 1 on errors.
// Usage: node <skill>/scripts/check-config.mjs [path/to/config.json]  (default: the atalaya folder's)
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { findHome, loadConfig, promptPath } = await import(join(root, 'lib/config.mjs'));
const { redact } = await import(join(root, 'lib/redact.mjs'));
const { READERS } = await import(join(root, 'lib/sessions.mjs'));

const home = findHome();
if (!process.argv[2] && !home) {
  console.error('✗ No atalaya folder found: run "atalaya init" or pass the config path');
  process.exit(1);
}
const file = resolve(process.argv[2] ?? join(home, 'config.json'));
const errors = [];
const warnings = [];

let cfg;
try {
  JSON.parse(readFileSync(file, 'utf8'));
  cfg = await loadConfig(file);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

for (const r of cfg.git.roots) if (!existsSync(r)) warnings.push(`git.roots: ${r} does not exist`);
if (!['local', 'remote', 'all'].includes(cfg.git.refs)) errors.push(`git.refs: "${cfg.git.refs}" (use local, remote or all)`);
for (const s of cfg.sources) if (!READERS[s]) errors.push(`sources: no reader for "${s}" (available: ${Object.keys(READERS).join(', ')})`);
if (typeof cfg.language !== 'string' || !cfg.language.trim()) errors.push('language: must be a language name, e.g. "English" or "Spanish"');
for (const label of Object.keys(JSON.parse(readFileSync(file, 'utf8')).machines ?? {})) {
  if (!/^[a-z0-9_-]+$/.test(label)) errors.push(`machines: "${label}" is not a valid label (a-z, 0-9, - and _); it must match ATALAYA_MACHINE`);
}
for (const key of ['before', 'after']) if (!Array.isArray(cfg[key])) errors.push(`${key}: must be a list of shell commands`);

const names = new Set();
for (const log of cfg.logs) {
  if (names.has(log.name)) errors.push(`logs: duplicate name "${log.name}"`);
  names.add(log.name);
  if (!cfg.agents[log.agent]) errors.push(`logs.${log.name}: unknown agent "${log.agent}"`);
  const prompt = promptPath(cfg, log.prompt);
  if (!existsSync(prompt)) errors.push(`logs.${log.name}: prompt ${log.prompt} does not exist`);
}
if (!cfg.logs.some((l) => l.daily !== false)) warnings.push('logs: none is written by "daily" (all have "daily": false)');

for (const [command, log] of Object.entries(cfg.bot?.commands ?? {})) {
  if (!/^[a-z0-9_]{1,32}$/.test(command)) errors.push(`bot.commands: "${command}" is not a valid Telegram command (only a-z, 0-9 and _)`);
  if (!names.has(log)) errors.push(`bot.commands.${command}: there is no log named "${log}"`);
}

const daily = new Set(cfg.logs.filter((l) => l.daily !== false).map((l) => l.name.toUpperCase().replace(/\W/g, '_')));
for (const cmd of cfg.after) {
  for (const [, n] of cmd.matchAll(/\$\{?ATALAYA_LOG_([A-Z0-9_]+)/g)) {
    if (!daily.has(n)) warnings.push(`after: uses ATALAYA_LOG_${n}, but that log is not written by "daily"; it will be empty`);
  }
}

// A secret in the config would end up in git and in the logs: it belongs in .env, used as $VARIABLE
const raw = readFileSync(file, 'utf8');
if (redact(raw, cfg.redact) !== raw) errors.push('there seems to be a secret written in the config; move it to .env and reference it as $VARIABLE');

for (const w of new Set(warnings)) console.log(`⚠ ${w}`);
for (const e of errors) console.log(`✗ ${e}`);
if (errors.length) process.exit(1);
console.log(`✓ ${file} (machine ${cfg.machine}): ${cfg.sources.length} sources, ${cfg.logs.length} logs (${[...daily].length} in daily), ${cfg.after.length} after commands, language ${cfg.language}`);
