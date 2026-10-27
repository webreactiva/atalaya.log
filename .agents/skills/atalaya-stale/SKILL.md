---
name: atalaya-stale
description: Find dead, abandoned or forgotten projects with atalaya.log — repos and folders that had commits or AI agent sessions in the last months but nothing lately — and help decide what to do with each. Use this skill whenever the user asks which projects are dead, stale, abandoned, forgotten, parked or "haven't been touched in a long time", wants a project cleanup or review ("what should I archive?", "what did I leave half done?", "proyectos muertos", "qué tengo abandonado"), or wants to change how long counts as stale, even if they don't name atalaya.
---

# atalaya-stale

atalaya records every commit and agent session per project (see the `atalaya` skill for the tool itself). `atalaya stale` uses that record to list projects that were alive in the watched window and have gone quiet since.

## Run it

```bash
atalaya stale                         # defaults from config.json: "stale": { "idle": "30d", "window": "90d" }
atalaya stale --idle 14d --window 60d # one-off thresholds
atalaya stale --no-collect            # skip reading git and sessions first (faster, may miss recent work)
```

A project is **watched** if it had any commit, agent session or `atalaya report` within `window`, and **stale** if its last one is older than `idle`. Activity from every machine counts (see "Several machines" in the README), and folders in `hide` are left out. Projects with no activity in the whole window are not listed: they were already dead before it began; widen `window` to see them.

By default the command first runs a `collect` over the whole window, so a project never looks stale just because its days were never collected. That reads every repo under `git.roots` and can take a while; use `--no-collect` when the store is known to be up to date (the nightly `daily` keeps it so).

## Read the result to the user

The output is a Markdown table, oldest first: project, last active day, days idle, commits and agent session-days in the window. Don't just paste it back. For each stale project worth discussing, look closer before suggesting anything:

```bash
atalaya show --project <name> --since 90d    # what the last work was
git -C <repo> status --short                 # uncommitted work left behind?
git -C <repo> log -1 --format='%cr %s'       # the last commit in its own words
```

Then group them by what they look like: finished (a last commit like a release or "done"), interrupted (uncommitted changes, an open branch, an agent session that ended mid-task), or experiments that ran their course. Offer next steps per group: archive, write a closing note, pick it back up, or drop it from `git.roots`.

Archiving, deleting, moving or pushing anything is the user's call: propose it, never do it on your own. To stop a finished project from being listed again, suggest adding its path to `hide` in `config.json` (it only affects output) and run the `atalaya` skill's config checker afterwards.

## Thresholds

`stale.idle` and `stale.window` in `config.json` take `30d`, `12h`, `90m`… and `idle` must be shorter than `window`. If the user says "more than two months", that is `"idle": "60d"`; widen `window` so it stays longer than `idle`.
