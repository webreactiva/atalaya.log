// Deterministic readers for the local sessions of Claude Code, Codex, OpenCode and pi.
// Each session is split by local day: a session crossing midnight gives two records.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { localDate } from './time.mjs';

export const DEFAULT_PATHS = {
  claude: '~/.claude/projects',
  codex: '~/.codex/sessions',
  opencode: '~/.local/share/opencode/opencode.db',
  pi: '~/.pi/agent/sessions',
};
const MAX_PROMPT_CHARS = 500;

const clip = (s) => (s.length > MAX_PROMPT_CHARS ? s.slice(0, MAX_PROMPT_CHARS) + '…' : s).replace(/\s+/g, ' ').trim();
// Messages injected by the tool (commands, context, reminders), not typed by the person
const isNoise = (text) => !text.trim() || /^\s*</.test(text);

async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // line cut off while the session was still writing
    }
  }
}

async function recentFiles(dir, from, match, maxDepth, depth = 0, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < maxDepth) await recentFiles(p, from, match, maxDepth, depth + 1, out);
    else if (e.isFile() && match(e.name) && (await stat(p)).mtimeMs >= from) out.push(p);
  }
  return out;
}

// Accumulates by (session, day)
class Buckets {
  map = new Map();
  constructor(tool, from, to) {
    Object.assign(this, { tool, from, to });
  }
  get(id, ts, defaults = {}) {
    const ms = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!(ms >= this.from && ms < this.to)) return null;
    const day = localDate(ms);
    const key = `${id}|${day}`;
    let s = this.map.get(key);
    if (!s) {
      s = { tool: this.tool, id, day, project: null, title: null, model: null, start: null, end: null, prompts: [], files: new Set(), toolCalls: 0, ...defaults };
      this.map.set(key, s);
    }
    const iso = new Date(ms).toISOString();
    if (!s.start || iso < s.start) s.start = iso;
    if (!s.end || iso > s.end) s.end = iso;
    return s;
  }
  list(meta = {}) {
    return [...this.map.values()].map((s) => ({ ...s, ...meta[s.id], files: [...s.files].sort() }));
  }
}

// ---------- Claude Code: <root>/<project>/<session>.jsonl ----------
async function readClaude(root, from, to) {
  // maxDepth 1: main sessions only, not subagents
  const files = await recentFiles(root, from, (n) => n.endsWith('.jsonl'), 1);
  const b = new Buckets('claude', from, to);
  const meta = {};
  for (const file of files) {
    const id = file.split('/').pop().replace('.jsonl', '');
    for await (const e of lines(file)) {
      if (e.type === 'ai-title') (meta[id] ??= {}).title = e.aiTitle;
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      const s = b.get(id, e.timestamp, { project: e.cwd });
      if (!s) continue;
      const content = e.message?.content;
      if (e.type === 'user' && !e.isMeta) {
        const texts = typeof content === 'string' ? [content] : (content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
        for (const t of texts) if (!isNoise(t)) s.prompts.push(clip(t));
      }
      if (e.type === 'assistant') {
        s.model ??= e.message?.model;
        for (const c of Array.isArray(content) ? content : []) {
          if (c.type !== 'tool_use') continue;
          s.toolCalls++;
          const f = c.input?.file_path ?? c.input?.notebook_path;
          if (f && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) s.files.add(f);
        }
      }
    }
  }
  return b.list(meta);
}

// ---------- Codex: <root>/YYYY/MM/DD/rollout-*.jsonl ----------
// shortcut: the 2025 format (no `payload`, no per-line date) is ignored; support it if you need to look that far back
export function patchFiles(text) {
  return [...String(text).matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)].map((m) => m[1].trim());
}

async function readCodex(root, from, to) {
  const files = await recentFiles(root, from, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), 3);
  const b = new Buckets('codex', from, to);
  for (const file of files) {
    const id = file.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? file;
    let cwd = null;
    let model = null;
    for await (const e of lines(file)) {
      const p = e.payload ?? {};
      if (e.type === 'session_meta') cwd = p.cwd;
      if (e.type === 'turn_context') model ??= p.model;
      if (e.type !== 'response_item') continue;
      const s = b.get(id, e.timestamp, { project: cwd, model });
      if (!s) continue;
      if (p.type === 'message' && p.role === 'user') {
        for (const c of p.content ?? []) if (c.text && !isNoise(c.text)) s.prompts.push(clip(c.text));
      }
      if (/(function|custom)_tool_call$/.test(p.type)) {
        s.toolCalls++;
        // apply_patch arrives on its own or inside exec code; either way with these headers
        for (const f of patchFiles(p.input ?? p.arguments)) s.files.add(f);
      }
    }
  }
  return b.list();
}

// ---------- OpenCode: SQLite ----------
async function readOpencode(dbPath, from, to) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // shortcut: root sessions of the v2 tables only (OpenCode ≥ 2); subagents and the old schema are ignored
    const rows = db
      .prepare(
        `SELECT s.id, s.title, s.directory, m.type, m.time_created AS ts, m.data
         FROM session_v2 s JOIN session_message m ON m.session_id = s.id
         WHERE s.parent_id IS NULL AND s.time_updated >= ? AND m.time_created >= ? AND m.time_created < ? AND m.type IN ('user', 'assistant')
         ORDER BY m.time_created`,
      )
      .all(from, from, to);
    const b = new Buckets('opencode', from, to);
    for (const r of rows) {
      const s = b.get(r.id, r.ts, { title: r.title, project: r.directory });
      const data = JSON.parse(r.data);
      if (r.type === 'user' && data.text && !isNoise(data.text)) s.prompts.push(clip(data.text));
      if (r.type === 'assistant') {
        s.model ??= data.model?.id;
        for (const c of data.content ?? []) {
          if (c.type !== 'tool') continue;
          s.toolCalls++;
          const f = c.state?.input?.path ?? c.state?.input?.filePath;
          if (f && (c.name === 'edit' || c.name === 'write')) s.files.add(f);
        }
      }
    }
    return b.list();
  } finally {
    db.close();
  }
}

// ---------- pi: <root>/--<cwd>--/<date>_<session>.jsonl ----------
async function readPi(root, from, to) {
  const files = await recentFiles(root, from, (n) => n.endsWith('.jsonl'), 1);
  const b = new Buckets('pi', from, to);
  for (const file of files) {
    let id = file;
    let cwd = null;
    let model = null;
    for await (const e of lines(file)) {
      if (e.type === 'session') [id, cwd] = [e.id, e.cwd];
      if (e.type === 'model_change') model = e.modelId;
      if (e.type !== 'message') continue;
      const { role, content } = e.message ?? {};
      if (role !== 'user' && role !== 'assistant') continue;
      const s = b.get(id, e.timestamp, { project: cwd, model });
      if (!s) continue;
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);
      if (role === 'user') for (const c of parts) if (c.type === 'text' && !isNoise(c.text)) s.prompts.push(clip(c.text));
      if (role === 'assistant') {
        for (const c of parts) {
          if (c.type !== 'toolCall') continue;
          s.toolCalls++;
          // pi stores paths relative to the session's folder
          if ((c.name === 'edit' || c.name === 'write') && c.arguments?.path) s.files.add(resolve(cwd ?? '/', c.arguments.path));
        }
      }
    }
  }
  return b.list();
}

export const READERS = { claude: readClaude, codex: readCodex, opencode: readOpencode, pi: readPi };
