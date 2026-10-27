---
name: atalaya
description: Configure, run and troubleshoot atalaya.log, the daily logbook that reads git repos and local AI agent sessions (Claude Code, Codex, OpenCode, pi) and has an agent write daily logs (daily, tldr, roast, bro). Use this skill whenever the user wants to change what atalaya reads or writes — add or remove repo folders, rename or hide paths, enable a log every night or only on demand, write or tweak a log prompt, add an agent, set up Telegram, email or automatic git push after the daily log, run or fix the Telegram bot, the cron job, `collect`/`show`/`log`/`daily`/`discover` — or asks things like "what did I do yesterday?", "redo Tuesday's roast", "add this folder to atalaya", "send me the tldr every night", "the Telegram message never arrived", "set up atalaya", "write my logs in French", in any language and even if they don't name the tool.
---

# atalaya.log

atalaya has two halves, and keeping them apart is the whole design:

- **Deterministic:** `collect` reads git and the agents' session files, strips secrets and upserts into `atalaya.db` (SQLite). Commits are keyed by hash, sessions by (agent, id, day). Re-collecting never duplicates; nothing is lost when an agent prunes its own logs.
- **Agent-driven:** `log` sends a prompt plus the day's data (exactly what `show` prints) to an agent CLI in headless mode and saves its Markdown to `logs/<name>/<date>.md`. `discover` asks an agent where it stores its sessions.

Everything the user owns lives in **their atalaya folder**, created by `atalaya init` (often `~/scripts/atalaya`). Find it with `cat ~/.config/atalaya/home`, or `$ATALAYA_HOME` if set. Paths below are relative to it. The installed package (code and bundled prompts) is not the user's: don't edit it.

## Files you will touch

| File | What it is | Rule |
|---|---|---|
| `config.json` | All behaviour | Edit it, then run the checker |
| `.env` | Secrets for `after` commands and the bot | Never print its values, never copy them elsewhere |
| `prompts/*.md` | One prompt per log. `{date}` is replaced; the data is appended after `---`. Looked up here first, then in the package | Plain Markdown instructions |
| `logs/<name>/<date>.md` | Generated logs | Regenerate rather than hand-edit |
| `activity/<machine>/<date>.json` | Each machine's recorded day, exported by `daily`/`share` | Generated; commit it, never edit it |
| `atalaya.db` | The store | Read-only for you; never delete it, it is the only copy of pruned history |

The full key reference is in the package's `README.md` ("Configuration reference", "Full example", "`.env` variables"), two folders up from this skill. Read it when you need a key not covered here instead of guessing. If there is no atalaya folder yet, run `atalaya init` where the user wants their logs and read what it prints back to them.

## After every config change

```bash
node <this skill's folder>/scripts/check-config.mjs
```

It validates JSON, logs vs. prompts vs. agents, bot command names, `ATALAYA_LOG_<NAME>` used in `after` against the logs written in `daily`, and refuses secrets in the config. Fix every ✗; read every ⚠ to the user. Then verify the effect with the cheapest real command: `atalaya paths` for sources, `atalaya show --date yesterday | grep '^## '` for folders, aliases and hide. If the bot is running (`tmux has-session -t atalaya-bot`), restart it so it picks up the change:

```bash
tmux kill-session -t atalaya-bot; tmux new-session -d -s atalaya-bot "atalaya bot 2>&1 | tee -a $(cat ~/.config/atalaya/home)/bot.log"
```

Keep the config's compact style (one line per agent, per log, per `after` command) when you edit it; it is meant to be read by a person.

## Common tasks

**Folders.** Repos are found under `git.roots` up to `maxDepth`. `git.ignore` skips folder *names* anywhere (it changes what is read). `hide` drops *paths* from the output only, and `aliases` renames path prefixes (`{"~/Sites/lab": "/lab"}`, longest match wins). Prefer `hide`/`aliases` for cosmetic requests: the store keeps real paths, so they are reversible.

**Logs.** Defaults when `logs` is absent: `daily` every night; `tldr`, `roast`, `bro` on demand. `"daily": true|false` per log decides whether `atalaya daily` writes it. On demand: `atalaya log --date yesterday --name roast`. Each log is one agent call (about a minute with Claude), so ask before turning many on nightly.

**Language.** `language` in the config (e.g. `"Spanish"`) replaces `{language}` in every prompt; `logs[].language` overrides it for one log. Change the language there, never by translating the prompts.

**Prompts.** Copy the closest one in `prompts/` and adapt it, keeping it in English with a `{language}` placeholder. Keep the rules that matter: use only the data, never copy secrets, reply with the output only. `daily` cites short commit hashes; `tldr`, `roast` and `bro` must not. Test with `atalaya log --date yesterday --name <log>` and show the user the result.

**Agents.** `agents.<name>.headless` is the command used for logs (`{prompt}` marks the slot). Sources need no agent: `claude`, `codex`, `opencode` and `pi` are read straight from disk. If `atalaya paths` shows ✗, try `atalaya discover <name>`, else set `agents.<name>.path`. A headless failure like 401 or "no credits" is the user's login or billing; say so instead of retrying.

**After commands** (Telegram, email, git push). They run in the atalaya folder with `ATALAYA_DATE`, `ATALAYA_DATA_DIR`, `ATALAYA_MACHINE`, `ATALAYA_LOGS` (one path per line) and `ATALAYA_LOG_<NAME>`; the first failure stops the rest. Copy the tested commands from README "Extras" rather than writing new ones. Secrets go in `.env` as variables (`$TELEGRAM_BOT_TOKEN`), never inline. These commands send data off the machine: confirm with the user before the first real run, and test with `atalaya daily --date yesterday` once they agree.

**Telegram bot.** `atalaya bot` answers only `TELEGRAM_CHAT_ID`. `bot.commands` maps command → log name; Telegram allows only `a-z`, `0-9`, `_` (so `/roast_me`, not `/roast-me`). A missing day is generated on the spot; today is always regenerated.

**Git.** The atalaya folder is its own repo with a `pre-commit` hook running `atalaya guard`, which refuses `.env`, `atalaya.db*` and any staged file holding a secret. Never bypass it with `--no-verify` on your own; if it blocks, show the user what it found. Stage explicit paths (`git add config.json prompts logs activity`), not `-A`.

**Several machines.** Each computer has a label, `ATALAYA_MACHINE` in its `.env` (`atalaya paths` prints it). `daily` exports this machine's day to `activity/<label>/<day>.json` and imports the other machines' files, so they must share the atalaya repo: `"before": ["git pull -q --rebase --autostash"]` and the git push `after` command (with `activity`) on every machine. Per-machine differences go in `machines.<label>` (merged over the config; `git` and `agents` key by key); a machine that only feeds the logbook gets `"logs": []`. A new machine: clone the repo and run `atalaya init` inside it, which keeps `config.json`. Renaming a label leaves old rows under the old name, so choose it before the first `daily`.

**Stale projects.** For dead or forgotten projects use the `atalaya-stale` skill (`atalaya stale`, thresholds in `stale.idle` / `stale.window`).

**Agent reports.** `atalaya report "<what got finished>" --source <agent>` stores one line tied to the current folder. If the user wants agents to report on their own, propose the snippet from README "Agent reports" for their global `CLAUDE.md`/`AGENTS.md`; that file is theirs, so ask before editing it.

## Answering "what did I do?"

Don't ask an agent to write a log just to answer a question. Run `atalaya collect --date <day>` (cheap, idempotent) and read `atalaya show --date <day>` or `atalaya show --project <text> --since 7d`, then answer from that. Each project in the output carries an estimated time (blocks of activity less than 60 min apart, +5 min each). It is an estimate: open sessions and other people's commits inflate it.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Nothing from an agent | `atalaya paths`; then `atalaya collect --since 24h` prints a count per source |
| A folder is missing | Is it under `git.roots` within `maxDepth`, not in `git.ignore` or `hide`? |
| `log` fails | Run the agent's headless command by hand with a tiny prompt; check login |
| Telegram/email silent | Run the `after` command alone with the `ATALAYA_*` variables exported; `curl -f` exits non-zero on API errors |
| Cron did nothing | `cron.log` in the atalaya folder; cron needs a `PATH` with `atalaya`, `node` and the agent CLI |
| Bot not answering | `tmux has-session -t atalaya-bot`, `tail bot.log`, `TELEGRAM_CHAT_ID` matches the chat |
| "No atalaya folder found" | No `init` yet, or the pointer moved: `atalaya init` there, or pass `--home` |

Sessions started by atalaya itself begin with `[atalaya]` and are not recorded, so your own `log`/`discover` calls don't pollute the user's history.
