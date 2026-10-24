// The non-deterministic part: asking agents (headless or, if that fails, driving them through tmux).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { expand } from './config.mjs';

const run = promisify(execFile);
const shellQuote = (a) => `'${a.replaceAll("'", "'\\''")}'`;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

// Replaces {prompt} in the configured command; without it, the prompt goes last
const withPrompt = (cmd, prompt) => (cmd.includes('{prompt}') ? cmd.map((a) => (a === '{prompt}' ? prompt : a)) : [...cmd, prompt]);

export async function askHeadless(agent, prompt, { timeout = 300_000 } = {}) {
  const [bin, ...args] = withPrompt(agent.headless, prompt);
  try {
    const pending = run(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024, cwd: tmpdir() });
    pending.child.stdin.end(); // codex exec waits on stdin while it is open
    const { stdout } = await pending;
    return { text: stdout.trim() };
  } catch (e) {
    const reason = e.killed ? `no answer in ${timeout / 1000} s` : String(e.stderr || '').replace(ANSI, '').trim().split('\n').pop() || `${bin} exited with code ${e.code}`;
    return { error: reason.slice(0, 300) };
  }
}

// Starts the interactive agent in tmux, types the question and reads the screen until a valid path shows up
export async function askTmux(name, agent, prompt, { timeout = 120_000, accept, workdir }) {
  const session = `atalaya-${name}-${process.pid}`;
  const tmux = (...args) => run('tmux', args).then((r) => r.stdout);
  try {
    // Inside a shell: if the agent dies on startup, its error stays on screen
    mkdirSync(workdir, { recursive: true });
    await tmux('new-session', '-d', '-s', session, '-x', '220', '-y', '60', '-c', workdir);
    await tmux('send-keys', '-t', session, '-l', agent.interactive.map(shellQuote).join(' '));
    await tmux('send-keys', '-t', session, 'Enter');
    await sleep(8000); // TUI startup
    // workdir is an empty folder owned by atalaya: accepting "trust this folder?" exposes nothing
    if (/trust (this|the) (folder|directory)|do you trust/i.test(await tmux('capture-pane', '-p', '-t', session))) {
      await tmux('send-keys', '-t', session, 'Enter');
      await sleep(5000);
    }
    await tmux('send-keys', '-t', session, '-l', prompt);
    await sleep(500);
    await tmux('send-keys', '-t', session, 'Enter');
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(3000)) {
      const screen = (await tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', session)).replace(ANSI, '');
      // only what comes after the question, so the TUI header isn't mistaken for the answer
      const at = screen.lastIndexOf(prompt.slice(-40));
      if (at === -1) continue; // the question is not on screen yet
      const answer = screen.slice(at + 40);
      const found = accept(answer);
      if (found) return { text: answer.trim(), found };
    }
    const last = (await tmux('capture-pane', '-p', '-t', session)).replace(ANSI, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
    return { error: `tmux: no useful answer in ${timeout / 1000} s; last screen: ${last.slice(0, 300)}` };
  } catch (e) {
    return { error: `tmux: ${String(e.stderr || e.message).trim()}` };
  } finally {
    await tmux('kill-session', '-t', session).catch(() => {});
  }
}

// Marks the sessions atalaya starts, so it doesn't record itself
export const MARKER = '[atalaya]';
export const isOwnSession = (s) => /^\W*\[atalaya\]/.test(s.prompts[0] ?? '');

export const discoverPrompt = (name) =>
  `${MARKER} Reply with the absolute path only, no explanation: where on this machine does ${name} store its local session history (the files or the database holding the conversations)?`;

// The answer is free text from a model: only an existing path outside the temp folder counts
export const existingPath = (text) =>
  text.match(/(?:~|\/)[^\s`'"()<>│]+/g)?.map((p) => expand(p.replace(/[.,:;]+$/, ''))).find((p) => existsSync(p) && !p.startsWith(tmpdir()) && p !== '/' && p !== homedir()) ?? null;

export async function discover(name, agent, { tmux = true, workdir } = {}) {
  const prompt = discoverPrompt(name);
  const attempts = [];
  const headless = await askHeadless(agent, prompt, { timeout: 120_000 });
  const path = headless.text && existingPath(headless.text);
  if (path) return { path, method: 'headless', answer: headless.text, attempts };
  attempts.push(`headless: ${headless.error ?? 'answered without a valid path'}`);
  if (tmux && agent.interactive) {
    const viaTmux = await askTmux(name, agent, prompt, { accept: existingPath, workdir });
    if (viaTmux.found) return { path: viaTmux.found, method: 'tmux', answer: viaTmux.text.slice(-2000), attempts };
    attempts.push(viaTmux.error);
  }
  return { error: attempts.join(' · '), attempts };
}
