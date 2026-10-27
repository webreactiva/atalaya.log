# atalaya.log

A daily logbook of everything you did, per project and per day. It reads your git repos and your local AI coding sessions (Claude Code, Codex, OpenCode, pi), stores them in a local database, and lets an agent write the daily log from a prompt you control.

- **Deterministic part:** `collect` reads git and the agents' session files, strips secrets and stores everything in a local SQLite file (`atalaya.db`). Commits are keyed by hash and sessions by (agent, id, day), so collecting twice never duplicates anything, and data survives even if an agent deletes its old logs.
- **Agent part:** `discover` asks each agent where it keeps its sessions (headless first, tmux as a fallback). `log` sends a prompt plus the day's data to an agent and saves the Markdown it returns.
- **Extras:** after the daily log, run any shell commands you like: commit and push the logs, send them to Telegram, email them.

Secret tokens, passwords, keys and credential URLs are redacted before anything is stored, sent to an agent or written to a log. File contents and tool output are never read, only your commits and the messages you typed.

**Naming:** the project, the npm package and the repo are `atalaya.log`; everything you type or that lands on disk is just `atalaya`: the command, your folder (`~/scripts/atalaya`), `~/.config/atalaya`, `atalaya.db`, the skill.

Logs are written in the language you set in `config.json` (`"language": "Spanish"`, `"French"`…); `init` picks it from your system locale.

## Requirements

- macOS or Linux
- Node.js **24 or newer** (uses the built-in `node:sqlite`)
- git
- At least **one** agent CLI, logged in, to write the logs: `claude`, `codex`, `opencode` or `pi`. Reading sessions needs no agent at all.
- Optional: `tmux`, only for the `discover` fallback.

## Install

**1. Install the CLI**

```bash
npm install -g github:webreactiva/atalaya.log
atalaya help
```

There are no dependencies. To run it from a clone instead: `git clone git@github.com:webreactiva/atalaya.log.git atalaya && cd atalaya && npm link`.

**2. Create your atalaya folder.** Run `init` in the folder where you want your logs to live; it becomes your atalaya folder (like `git init`). for example `~/scripts/atalaya`:

```bash
mkdir -p ~/scripts/atalaya && cd ~/scripts/atalaya
atalaya init                       # or: atalaya init ~/scripts/atalaya --roots ~/code,~/work
```

If the folder already has a `config.json` (a clone of your atalaya repo), `init` keeps it and sets up everything else. `init` detects which agents you have, picks one to write the logs and the language from your locale, guesses your code folders, and creates:

```
~/scripts/atalaya/
├── config.json     # everything atalaya does
├── .env            # secrets for Telegram, email… (chmod 600, git-ignored)
├── prompts/        # one prompt per log; edit them freely
├── logs/           # the logs, one folder per log: logs/daily/2026-10-23.md
├── activity/       # each machine's recorded day, to share it (see Several machines)
├── .gitignore      # always written (or completed): .env, atalaya.db*, workdir/, *.log
├── .git/           # the folder is its own repo, with a pre-commit secrets guard
└── atalaya.db      # the store (created on the first collect)
```

**The folder is made to be versioned without leaking anything.** `init` runs `git init` (unless the folder is already inside another repo, which it leaves alone) and installs a `pre-commit` hook that runs `atalaya guard`. The guard refuses any commit that stages `.env`, the database, or a file in which the redactor finds a secret, even if you forced it past `.gitignore` with `git add -f`. If you already had a `pre-commit` hook, it is kept and `init` tells you to add `atalaya guard` to it.

It also records the folder in `~/.config/atalaya/home`, so `atalaya` finds it from anywhere: cron, the bot, or an agent running `atalaya report` inside another project. To use a different folder for one command, pass `--home <dir>` or set `ATALAYA_HOME`. Running `init` again elsewhere moves the pointer to the new folder.

**3. Tell it what to read.** Open `config.json` and check `git.roots` (the folders searched for repos, up to `maxDepth` levels deep) and `sources` (the agents whose sessions are read):

```json
{
  "git": { "roots": ["~/code", "~/work"], "maxDepth": 3 },
  "sources": ["claude", "codex", "opencode", "pi"]
}
```

```bash
atalaya paths          # ✓ / ✗ for each source
atalaya discover pi    # only for a ✗: asks the agent where it stores its sessions
```

If an agent can't answer, set the path by hand: `"agents": { "pi": { "path": "~/.pi/agent/sessions" } }`.

**4. Try it**

```bash
atalaya collect --since 7d      # fill the store with the last week
atalaya show --date yesterday   # exactly what the agent will receive
atalaya log --date yesterday    # the agent writes logs/daily/<date>.md
```

**5. Run it every day.** `daily` = `collect` + `log` + `after`. Run it just after midnight on the previous day so nothing is cut off. `init` prints the exact cron lines for your machine; cron doesn't load your shell, so the `PATH` must contain `atalaya`, `node` and your agent CLI:

```bash
crontab -e
```

```cron
PATH=/Users/you/.nvm/versions/node/v24.11.0/bin:/Users/you/.local/bin:/usr/local/bin:/usr/bin:/bin
10 0 * * * atalaya daily --date yesterday >> $HOME/scripts/atalaya/cron.log 2>&1
```

Check `cron.log` the next morning. On macOS, an agent that keeps its login in the Keychain may fail under cron; if so, run it from a `launchd` agent instead.

**6. Optional: let your agents manage it.** `atalaya skill install` links the bundled skill into `~/.claude/skills` and `~/.agents/skills`. Then you can ask your agent things like "add ~/work/api to atalaya", "send me the roast every night" or "what did I do yesterday in yesyak?".

## Logs

Each entry in `logs` produces `logs/<name>/<date>.md`, written by `agent` from `prompt`. One agent is enough for every log. `init` sets up four: `daily` (the changelog, written every night) and `tldr`, `roast` and `bro`, written only when you ask for them (`atalaya log --name roast`, or `/roast_me` in the [bot](#telegram-bot-tldr-roast_me)). To get any of them every night too, set `"daily": true` on it:

```json
"logs": [
  { "name": "daily", "agent": "claude", "prompt": "prompts/daily.md" },
  { "name": "tldr", "agent": "claude", "prompt": "prompts/tldr.md", "daily": true },
  { "name": "roast", "agent": "claude", "prompt": "prompts/roast.md", "daily": true },
  { "name": "bro", "agent": "claude", "prompt": "prompts/bro.md", "daily": true }
]
```

A prompt path is looked up in your atalaya folder first and then among the bundled prompts, so your edits win and a missing file falls back to the default. `{date}` is replaced with the day; the raw data is appended after a `---` line. A minimal prompt looks like this:

```markdown
You are the chronicler of my work. Below the `---` line is the raw data of what I did on {date}:
git commits and AI agent sessions, grouped by project folder.

Write the changelog for that day in Markdown:
1. `# Log for {date}` and a `## Summary` with 3 to 6 bullets.
2. One `##` section per folder with real activity: what was done and why. Cite short commit hashes.
3. Anything left half-done goes under `## Pending`.

Use only what is in the data. Never copy tokens, passwords or keys. Reply with the Markdown only.
```

## Extras: actions after the daily log

Commands in `after` run in order, from your atalaya folder, once the logs are written. They receive:

| Variable | Value |
|---|---|
| `ATALAYA_DATE` | The day, `YYYY-MM-DD` |
| `ATALAYA_DATA_DIR` | Your atalaya folder, e.g. `/Users/you/scripts/atalaya` |
| `ATALAYA_LOGS` | The log files just written, one path per line, in the order of `logs` |
| `ATALAYA_LOG_<NAME>` | The file of one log, by its name in uppercase: `ATALAYA_LOG_DAILY`, `ATALAYA_LOG_TLDR`… (empty when that log wasn't written) |

If a command fails, the following ones don't run and `daily` exits with an error.

**Secrets go in `.env`** in your atalaya folder, never in `config.json`. atalaya loads it on every run, so cron and the bot see it too. `init` creates it with commented placeholders, readable only by you, and git-ignored.

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Send any message (e.g. `/start`) to your new bot. A bot can only write to chats that have talked to it first.
3. Get your chat id:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*'
   ```
4. Add both to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_CHAT_ID=12345678
   ```
5. Add the command to `after` (sends each log as a document):
   ```json
   "after": [
     "for f in $ATALAYA_LOGS; do curl -sf -o /dev/null \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendDocument\" -F chat_id=\"$TELEGRAM_CHAT_ID\" -F caption=\"Log $ATALAYA_DATE\" -F document=@\"$f\" || exit 1; done"
   ]
   ```
6. Test it: `atalaya daily --date yesterday`.

To get the [TL;DR](#bundled-prompts) as a readable message and the other logs as files, add a `tldr` log and use these two commands instead:

```json
"after": [
  "[ -z \"$ATALAYA_LOG_TLDR\" ] || curl -sf -o /dev/null \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage\" -d chat_id=\"$TELEGRAM_CHAT_ID\" --data-urlencode text@\"$ATALAYA_LOG_TLDR\"",
  "for f in $ATALAYA_LOGS; do [ \"$f\" = \"$ATALAYA_LOG_TLDR\" ] && continue; curl -sf -o /dev/null \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendDocument\" -F chat_id=\"$TELEGRAM_CHAT_ID\" -F caption=\"Log $ATALAYA_DATE\" -F document=@\"$f\" || exit 1; done"
]
```

Telegram messages are limited to 4,096 characters, which is why the TL;DR prompt asks for less than 800.

### Telegram bot: `/tldr`, `/roast_me`…

`atalaya bot` keeps listening to your bot and answers with a log on demand:

- `/tldr` → the latest TL;DR that exists.
- `/tldr yesterday`, `/tldr today`, `/tldr 2026-10-20` → that day. A missing day is collected and written on the spot (about a minute); today is always rewritten, since it keeps changing.
- Anything else → the list of commands.

It only answers `TELEGRAM_CHAT_ID`; messages sent while it was stopped are dropped. Commands map to log names in the config (Telegram allows only `a-z`, `0-9` and `_`, so `roast-me` must be `roast_me`):

```json
"bot": { "commands": { "daily": "daily", "tldr": "tldr", "roast_me": "roast", "bro": "bro" } }
```

Without `bot.commands`, there is one command per log, named after it. Keep it running in tmux or as a `launchd`/`systemd` service:

```bash
tmux new-session -d -s atalaya-bot 'atalaya bot 2>&1 | tee -a ~/scripts/atalaya/bot.log'
```

### Email

Uses `curl`'s built-in SMTP client, so nothing else to install. With Gmail, create an [app password](https://myaccount.google.com/apppasswords) (requires 2-step verification); other providers (Mailtrap, SendGrid, Fastmail…) work the same with their SMTP host; use `smtps://host:465` for TLS or `smtp://host:587` (or `2525`) for STARTTLS. `--ssl-reqd` refuses to send unencrypted.

1. Add to `.env`:
   ```
   SMTP_URL=smtps://smtp.gmail.com:465
   SMTP_USER=you@gmail.com
   SMTP_PASS=abcdabcdabcdabcd
   MAIL_FROM=you@gmail.com
   MAIL_TO=you@gmail.com
   ```
2. Add the command to `after` (one email per log):
   ```json
   "after": [
     "for f in $ATALAYA_LOGS; do { printf 'From: %s\\r\\nTo: %s\\r\\nSubject: Log %s\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\n' \"$MAIL_FROM\" \"$MAIL_TO\" \"$ATALAYA_DATE\"; cat \"$f\"; } | curl -sS --ssl-reqd --url \"$SMTP_URL\" --user \"$SMTP_USER:$SMTP_PASS\" --mail-from \"$MAIL_FROM\" --mail-rcpt \"$MAIL_TO\" -T - || exit 1; done"
   ]
   ```
3. Test it: `atalaya daily --date yesterday`.

To send **one** email per day with every log in it, the TL;DR first as a header, list `tldr` first in `logs` and use:

```json
"after": [
  "{ printf 'From: %s\\r\\nTo: %s\\r\\nSubject: Log %s\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\n' \"$MAIL_FROM\" \"$MAIL_TO\" \"$ATALAYA_DATE\"; for f in $ATALAYA_LOGS; do cat \"$f\"; printf '\\n\\n'; done; } | curl -sS --ssl-reqd --url \"$SMTP_URL\" --user \"$SMTP_USER:$SMTP_PASS\" --mail-from \"$MAIL_FROM\" --mail-rcpt \"$MAIL_TO\" -T -"
]
```

### Automatic git commit and push of the logs

Your atalaya folder is already a repo (see [Install](#install)): config, prompts and logs go in, `.env` and the database stay out, and the pre-commit guard blocks secrets.

1. Create an empty private repo on GitHub/GitLab, then:
   ```bash
   cd ~/scripts/atalaya
   git add .gitignore config.json prompts logs activity && git commit -m "First logs"
   git remote add origin git@github.com:you/my-logs.git
   git push -u origin HEAD
   ```
2. Make sure `git push` works without a password prompt (SSH key or credential helper), since cron can't type it.
3. Add the command to `after`:
   ```json
   "after": [
     "git add config.json prompts logs activity && (git diff --cached --quiet || git commit -qm \"log $ATALAYA_DATE ($ATALAYA_MACHINE)\") && git pull -q --rebase --autostash && git push -q"
   ]
   ```

You can combine all three: put them in `after` in the order you want them to run.

### Several machines

One logbook can cover several computers. Each one runs atalaya with the same atalaya repo, and the logs tell what happened on each.

- **Every machine has a label**: `ATALAYA_MACHINE` in its own `.env` (`init` writes the host name; change it before the first `daily`). `atalaya paths` shows it.
- **`daily` shares the day**: after `collect` it exports this machine's day to `activity/<label>/<day>.json` and imports the files the other machines pushed. Exports are redacted and byte-stable, so an unchanged day makes no git diff; folders in `hide` are never exported; imports are redacted again.
- **Nothing is counted twice**: a commit is stored by hash, so a repo cloned on two machines lists it once; sessions are keyed by agent, id and day.
- **The logs say where**: when a day has activity from more than one machine, each project is titled `## /lab/api · office` and the agent sees `Machines: laptop, office`. With one machine the output is unchanged.

Setup, using the git push above on every machine:

1. On the new machine, install atalaya and clone your atalaya repo, then run `init` inside the clone. It keeps the `config.json` it finds and sets up the rest: `.env` with this machine's label, the pre-commit guard, the pointer, the cron line.
   ```bash
   git clone git@github.com:you/my-logs.git ~/scripts/atalaya && cd ~/scripts/atalaya
   atalaya init      # then edit ATALAYA_MACHINE in .env if you want another label
   ```
2. Pull before reading, so the other machines' files are there:
   ```json
   "before": ["git pull -q --rebase --autostash"]
   ```
3. What differs per machine goes in `machines.<label>`, merged over the rest of the config (`git` and `agents` key by key). A machine that only feeds the logbook writes no logs:
   ```json
   "machines": {
     "office": { "git": { "roots": ["~/work"] }, "logs": [] }
   }
   ```
4. Schedule the machines that only feed it before the one that writes, e.g. `00:05` and `00:30`.

A machine that is off at night simply shares that day on its next `daily` run; the day already written does not include it unless you run `atalaya daily --date <day>` again.

## Commands

```bash
atalaya collect [--since 24h | --date YYYY-MM-DD] [--fetch]   # read git + sessions into the store
atalaya show [--date today | --since 7d] [--project text]     # print stored data as Markdown
atalaya discover [agent ...] [--no-tmux]                      # ask agents where their sessions live
atalaya log [--date today] [--name log]                       # an agent writes the configured logs
atalaya daily [--date today] [--no-after]                     # before + collect + share + log + after
atalaya share [--date today]                                  # export this machine's day, import the others'
atalaya report "what got finished" [--source agent]           # an agent records finished work
atalaya bot                                                   # Telegram bot: /tldr, /roast_me… [today|yesterday|YYYY-MM-DD]
atalaya paths                                                 # where each source is read from
atalaya init [dir] [--roots a,b] [--force]                    # create an atalaya folder (default: the current one)
atalaya skill install                                         # link the skill for your agents
atalaya guard                                                 # pre-commit check for secrets (installed by init)
```

`--date` accepts `today`, `yesterday` or `YYYY-MM-DD`. `--since` accepts `90m`, `24h`, `7d` or an ISO date. Every command accepts `--home <dir>` to use another atalaya folder.

## Configuration reference

| Key | Purpose |
|---|---|
| `language` | Language the logs are written in; replaces `{language}` in the prompts. Default `English`, per log with `logs[].language` |
| `dataDir` | Where `atalaya.db`, `logs/` and the tmux `workdir/` go. Default: the atalaya folder itself |
| `git.roots`, `maxDepth`, `ignore` | Folders searched for repos, and folder names to skip |
| `git.refs` | `local`, `remote` or `all` branches |
| `git.fetch` | Run `git fetch` before reading (slower, uses the network) |
| `git.authors` | Only commits by these authors (matched with OR). Empty = everyone |
| `git.concurrency` | Repos read in parallel |
| `sources` | Agents whose sessions are read: `claude`, `codex`, `opencode`, `pi` |
| `agents.<name>.headless` | Command used for `log` and `discover`. `{prompt}` marks where the prompt goes |
| `agents.<name>.interactive` | Command started in tmux when headless fails |
| `agents.<name>.path` | Fixed location of the agent's sessions (overrides `discover`) |
| `logs` | `[{ "name", "agent", "prompt", "project"?, "daily"?, "language"? }]`. `project` limits a log to folders containing that text. `"daily": false` skips it in `daily`; it is only written on demand (`atalaya log --name`, the bot) |
| `before` | Shell commands run at the start of `daily`, in order (e.g. `git pull`) |
| `after` | Shell commands run after `daily`, in order |
| `machines.<label>` | Overrides for one machine, merged over the rest (`git` and `agents` key by key). See [Several machines](#several-machines) |
| `bot.commands` | Telegram command → log name, for `atalaya bot` |
| `redact` | Extra regular expressions to scrub from everything |
| `aliases` | Display names for path prefixes, e.g. `{ "~/Sites/lab": "/lab" }`. The longest match wins |
| `hide` | Folders left out of `show` and the logs, with everything below them |

`aliases` and `hide` only change what is shown and sent to the agent. The store keeps the real paths, so you can change them at any time.

### Full example

This is a complete working setup: logs in Spanish, four sources, four logs written by Claude (`tldr` and `daily` every night, `roast` and `bro` on demand), the TL;DR to Telegram plus everything by email, and the bot.

```json
{
  "language": "Spanish",
  "git": {
    "roots": ["~/Sites/lab", "~/Sites/valet/sopravolare", "~/Sites/valet/imparare"],
    "maxDepth": 3,
    "ignore": ["node_modules", "vendor", ".next", "dist", "build", ".cache"],
    "concurrency": 8,
    "refs": "all",
    "fetch": false,
    "authors": []
  },
  "sources": ["claude", "codex", "opencode", "pi"],
  "agents": {
    "claude": { "headless": ["claude", "-p", "{prompt}"], "interactive": ["claude"] },
    "codex": { "headless": ["codex", "exec", "--skip-git-repo-check", "{prompt}"], "interactive": ["codex", "-c", "check_for_update_on_startup=false"] },
    "opencode": { "headless": ["opencode", "run", "{prompt}"], "interactive": ["opencode"] },
    "pi": { "headless": ["pi", "-p", "{prompt}"], "interactive": ["pi"] }
  },
  "logs": [
    { "name": "tldr", "agent": "claude", "prompt": "prompts/tldr.md", "daily": true },
    { "name": "daily", "agent": "claude", "prompt": "prompts/daily.md" },
    { "name": "roast", "agent": "claude", "prompt": "prompts/roast.md", "daily": false },
    { "name": "bro", "agent": "claude", "prompt": "prompts/bro.md", "daily": false }
  ],
  "after": [
    "[ -z \"$ATALAYA_LOG_TLDR\" ] || curl -sf -o /dev/null \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage\" -d chat_id=\"$TELEGRAM_CHAT_ID\" --data-urlencode text@\"$ATALAYA_LOG_TLDR\"",
    "for f in $ATALAYA_LOGS; do [ \"$f\" = \"$ATALAYA_LOG_TLDR\" ] && continue; curl -sf -o /dev/null \"https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendDocument\" -F chat_id=\"$TELEGRAM_CHAT_ID\" -F caption=\"Log $ATALAYA_DATE\" -F document=@\"$f\" || exit 1; done",
    "{ printf 'From: %s\\r\\nTo: %s\\r\\nSubject: Log %s\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\n' \"$MAIL_FROM\" \"$MAIL_TO\" \"$ATALAYA_DATE\"; for f in $ATALAYA_LOGS; do cat \"$f\"; printf '\\n\\n'; done; } | curl -sS --ssl-reqd --url \"$SMTP_URL\" --user \"$SMTP_USER:$SMTP_PASS\" --mail-from \"$MAIL_FROM\" --mail-rcpt \"$MAIL_TO\" -T -"
  ],
  "bot": { "commands": { "daily": "daily", "tldr": "tldr", "roast_me": "roast", "bro": "bro" } },
  "redact": [],
  "aliases": { "~/Sites/lab": "/lab" },
  "hide": ["~/Sites/lab/private-client/data"]
}
```

Notes on the defaults:

- Any key you leave out takes its default; `agents` are merged per agent, so `"agents": { "pi": { "path": "…" } }` keeps pi's commands.
- `git.ignore` matches folder **names** anywhere in the tree; `hide` matches **paths** and only affects the output.
- The Codex `interactive` command disables its update check: started in tmux, Codex would otherwise update itself.
- `logs[].prompt` is looked up in the atalaya folder, then among the bundled prompts, unless absolute. Each log is one agent call, about a minute with Claude.

### `.env` variables

Loaded from the atalaya folder on every run. None are required for the basic log.

| Variable | Used by |
|---|---|
| `ATALAYA_MACHINE` | This computer's label (default: its host name). See [Several machines](#several-machines) |
| `TELEGRAM_BOT_TOKEN` | Telegram, from @BotFather |
| `TELEGRAM_CHAT_ID` | Telegram, from `getUpdates` |
| `SMTP_URL` | Email, e.g. `smtps://smtp.gmail.com:465` or `smtp://sandbox.smtp.mailtrap.io:2525` |
| `SMTP_USER`, `SMTP_PASS` | Email login |
| `MAIL_FROM`, `MAIL_TO` | Email sender and recipient |

Variables already set in the environment win over `.env`.

## Bundled prompts

| File | Output |
|---|---|
| `prompts/daily.md` | The changelog: summary, one section per folder citing commit hashes, pending work, **suggested improvements** |
| `prompts/tldr.md` | Plain-text TL;DR with emoji, under 800 characters: date, total time, commits, one line per project and one 💡 suggestion. Made for a Telegram message or an email header |
| `prompts/roast.md` | A "roast me" of the day, with what actually went well at the end |
| `prompts/bro.md` | The day explained simply, like to a friend over a beer. Inspired by [bro-skill](https://github.com/luchasarie/bro-skill) |

All of them are written in English and ask the agent to answer in `{language}`. Only the changelog cites commit hashes; the TL;DR, the roast and bro don't.

The suggested-improvements section asks the agent for 2 to 4 concrete proposals backed by the data: repeated tasks worth automating, commits to squash or split, long-standing uncommitted work, long sessions with no outcome, prompts that could become a skill or a script. Delete those lines from the prompt if you don't want them.

## Estimated time per project

Every project in the data gets an estimated working time, in the style of Flavio Copes' [Factory Log](https://flaviocopes.com/factorylog/): commits, agent sessions and reports less than 60 minutes apart form one block, and each block adds 5 minutes for the work before its first mark. It's an estimate: an agent session left open counts in full, and with `git.refs: "all"` other people's commits pulled from remotes count too (set `git.authors` to avoid that).

## Agent reports

`atalaya report` stores what an agent says it finished, tied to the current folder, and prints JSON with its id. To make agents use it, add this to your global `~/.claude/CLAUDE.md` or `AGENTS.md`:

```markdown
When you finish a task with an outcome (something done, decided or dropped), run from the project folder:
atalaya report "<what got finished and how it ended, one sentence>" --source <claude|codex|opencode|pi>
```

It's an extra: if an agent forgets, the rest of the data is still there.

## Where data comes from

| Source | Default location | What is read |
|---|---|---|
| git | `git.roots` | Commits (hash, time, author, branch, subject, line counts) and uncommitted files |
| Claude Code | `~/.claude/projects` | Your prompts, edited files, model, session title |
| Codex | `~/.codex/sessions` | Your prompts, patched files, model |
| OpenCode | `~/.local/share/opencode/opencode.db` | Your prompts, edited files, model, title |
| pi | `~/.pi/agent/sessions` | Your prompts, edited files, model |

## Known limitations

- Codex: the 2025 session format is ignored.
- OpenCode: only root sessions of the v2 schema; no subagents.
- Claude Code: subagent files are not read.
- Uncommitted changes are a snapshot, stored only when the period includes "now".
- Sessions started by atalaya itself (`discover`, `log`) start with `[atalaya]` and are not recorded.
- The tmux fallback depends on each agent's TUI. It auto-accepts the "trust this folder?" prompt, but only inside `workdir/` in the atalaya folder.
- A day's data is passed to the agent as a command-line argument; above 400,000 characters `log` refuses and asks you to narrow it with `project`.

## Tests

```bash
npm test
```

## License

MIT © Daniel Primo
