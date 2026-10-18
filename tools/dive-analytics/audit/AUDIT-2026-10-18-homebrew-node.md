# A Homebrew run broke the Mini's Node; scheduled jobs move to the official Node build — 2026-10-18

The chain machine (the Hinterlands Mini) ran no Dive Radio morning on 2026-10-18 until 10:39.
Production served the 10-17 12:19 build for eight hours. Nothing in this repo failed. The Node
binary every scheduled job starts was broken by an unattended Homebrew run, and every check that
could have said why was a Node process too.

## What happened (America/Phoenix)

| Time | Event | Evidence |
|---|---|---|
| 01:11 | dotfiles `a2bb57f` adds `AGENT-SETUP.md`, a Mac-setup prompt for a coding agent. | dotfiles log |
| 01:17:33 | A Claude Code session on the Mini (`~/.claude/projects/-Users-bones-Dev-dotfiles/2196b8b2…`) runs its step 2: `brew bundle install --no-upgrade --file=~/Dev/dotfiles/Brewfile`. An earlier command in the same session had exported `HOMEBREW_NO_AUTO_UPDATE=1`, but each agent shell command starts fresh, so this run had none of it. | the session transcript; its `brew-bundle.log` |
| 01:17–01:18 | Homebrew auto-updates (`.git/FETCH_HEAD` 01:17, "71 outdated formulae"). It installs python@3.13, luajit, gitleaks, pnpm, the two zsh plugins and raycast, and upgrades their dependency openssl@3. The Brewfile's `brew "node"` ("Using node") links the installed node 25.6.1 as `/opt/homebrew/bin/node`, in place of node@24. node 25.6.1 was built against `libsimdjson.29`, and `opt/simdjson` pointed at 4.6.9 (`.33`). | `INSTALL_RECEIPT.json` times 01:18:22–26; Cellar mtimes; the dyld report naming `Cellar/node/25.6.1` searching `Cellar/simdjson/4.6.9` |
| 01:19:57 | First `node` crash report: `dyld: Library not loaded: …/libsimdjson.29.dylib`, SIGABRT in about 10 ms. 37 reports by 10:27. | `~/Library/Logs/DiagnosticReports/node-2026-10-18-*.ips` |
| 01:20 → | 38 of 114 OpenClaw jobs name `/opt/homebrew/bin/node`. Each one died in dyld before Node ran. | `openclaw cron list --all --json` |
| 06:50, 07:00, 08:15 | The Restream ingest, the 07:00 `run-daily.mjs --primary` and the 08:15 `recover-publish.mjs` die before Node starts. No attempt is recorded, so the ledger, the alert queue and scheduler-watch never see a run. | `daily-attempts.json` (no 10-18 entry until 10:39); job state |
| 06:50 | OpenClaw auto-disables `dive-alerts` (10 failures; its first failure was 01:20). Also auto-disabled today: roster refresh (07:30), workstation-sentinel (07:08), warboard-tasks-refresh (07:40), warboard-reply-poller (06:50), qmd-reindex (08:43). | `state.autoDisabled.atMs` |
| 09:21 | `brew reinstall node` installs node 26.12.0 and simdjson 5.0.5 (`.34`). `/opt/homebrew/bin/node` starts again, but node@24 24.20.0 (needs `.33`) no longer starts. That breaks `~/.local/bin/node` (a link to node@24), which the OpenClaw gateway, content-os, gateway-config-guard and breaking-dash-guard run on. | receipts 09:21:03–11 |
| 09:21–10:27 | The gateway process keeps running from memory, but its command helper re-launches the gateway's own node for every command. So every exec, command and script job fails in about 50 ms with `service child cleanup identity lost: write EPIPE`. 79 times, the 08:00 transcript mirror's run included. | `/tmp/openclaw/openclaw-2026-10-18.log`, first 16:21:10Z, last 17:27:15Z |
| 10:31–10:35 | A parallel session on the Mini (`…-hinterlands/7a46bf7e…`, started by Tommy) symlinks 4.6.9's `libsimdjson.33.dylib` into the 5.0.5 keg (a stopgap until the gateway restarts) and relinks `/opt/homebrew/bin/node` to node@24. Both nodes start; EPIPE stops. It re-enables the six disabled jobs and force-runs the failed ones. | its transcript; `ls -l` of both links |
| 10:46–10:47 | With Tommy's approval, that session installs the official nodejs.org v24.20.0 at `~/.local/share/node/node-v24.20.0-darwin-arm64` and points `~/.local/bin/node` and `/opt/homebrew/bin/node` at it. It adds the `node-runtime-check` job (every 10 minutes). | hinterlands `docs/decisions/node-runtime-2026-10-18.md` |
| 10:39 | The forced 07:00 job starts the day's first attempt (on node@24) and publishes `98d8520` at 10:44 (`generatedAt` 17:43:57Z). | chain-2026-10-18.log; live `data.json` |

## Why it was quiet

OpenClaw's own failure notice did reach channel `C0A9ZJTR1GS` for each core job: dive-alerts at
01:20, the ingest at 06:50, the 07:00 run, the 08:15 recovery and the transcript mirror at 09:21.
Each said only "command stopped by signal SIGABRT". Nothing named the cause. The paths built to
explain a failure were all Node and all dead:

- `dive-alerts`, the DM path, was switched off at 06:50;
- `scheduler-watch.mjs` runs inside dive-alerts, the daily run and the recovery check;
- the Hinterlands `workstation-sentinel` was switched off at 07:08.

## Decisions

1. **One official Node that Homebrew cannot move or break** (Tommy, 2026-10-18). Every scheduled
   job names `~/.local/bin/node`, which links to
   `~/.local/share/node/node-v24.20.0-darwin-arm64/bin/node`: the nodejs.org build, SHA-256
   checked, notarized (Node.js Foundation, HX7739G8FX), linking only macOS system libraries. The
   gateway wrapper, content-os, gateway-config-guard and breaking-dash-guard already ran
   `~/.local/bin/node`, so only the 38 job commands that named `/opt/homebrew/bin/node` move. That
   path sits inside Homebrew, and a `brew link`, `brew upgrade node` or Brewfile run can take it
   back. `/opt/homebrew/bin/node` stays pointed at the official build for interactive shells.

   **Why 24.20:**
   - It is the exact version the gateway and every long-running Node service already ran since
     2026-08-31, as Homebrew's node@24.
   - Node 24 is the current LTS ("Krypton"); Node 26 is still Current.
   - content-os's `better-sqlite3` is built for its ABI (137).
   - It passes every check below.

   A v24.22.0 build was also installed and tested this morning (`~/.local/runtimes`). It was
   removed once the same checks passed on 24.20, so the Mini keeps one runtime.

   **Upgrading Node:**
   - Unpack the new build beside the old one and run the same checks on it.
   - Repoint `~/.local/bin/node`.
   - Update the runtime watchdog's `APPROVED_DIR` and `APPROVED_VERSION`.
   - Have Tommy restart the gateway.
2. **Every Dive child runs on the scheduled Node** (`6eb28a7`). `run-chain.mjs` started each
   step as bare `node` with `/opt/homebrew/bin` first on PATH, so pinning the scheduled command
   alone would not have saved a single step.
   - Steps now start through `process.execPath`.
   - `runtime-paths.childEnv()` puts that Node's bin directory first on PATH and names it in
     `DIVE_NODE`.
   - `postlive-publish.sh` execs `$DIVE_NODE`.
   - The `openclaw` and `vercel` CLIs (`#!/usr/bin/env node`) run on the same Node, so Slack
     delivery and the scheduler check no longer depend on Homebrew's node.
   - The validator and live-parity checks that lock the wrapper's hand-off line moved with it
     (rule 4). They are tightened, not relaxed: the wrapper must hand off on the chain's Node.
3. **A dead runtime is loud without Node.**
   - **OpenClaw failure notices:** they stay on for the core jobs.
   - **`runtime-watchdog-cron-script.js`:** an OpenClaw native script payload, every five
     minutes, with no model and no Node of its own. It reports:
     - `~/.local/bin/node` or `/opt/homebrew/bin/node` failing `-v`;
     - `~/.local/bin/node` no longer resolving into the approved v24.20.0 build or printing its
       version (a later installer replacing the generic name);
     - `brew.env` losing one of its five guards;
     - a gateway that cannot start commands;
     - any core job switched off, or any job auto-disabled in the last day. It goes to Tommy's DM, once per problem, again
     every six hours while the problem lasts, and once when it clears.
   - **`scheduler-watch`:** it now starts each core job's executable with `-v` and queues one line
     per dead runtime per day, with the loader's own words.
4. **No unattended Homebrew changes.** `/opt/homebrew/etc/homebrew/brew.env` sets five guards
   for every `brew` run on the Mini:
   - `HOMEBREW_NO_AUTO_UPDATE`
   - `HOMEBREW_NO_INSTALL_UPGRADE`
   - `HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK`
   - `HOMEBREW_NO_INSTALL_CLEANUP`
   - `HOMEBREW_NO_AUTOREMOVE`

   The fifth is there because `brew uninstall node@24` (after the 11:10 gateway restart) also
   removed python@3.14 as "unused", and the Bones Agents API (kit) runs on it.

   Homebrew 7 reads that file itself, and its values win over the caller's environment, so it
   covers agent shells, LaunchAgents, cron jobs and people alike. `brew update` and
   `brew upgrade <formula>` still work when someone asks for them by name.
   - OpenClaw `env.vars` carries the same five values for the gateway and its children.
   - The dotfiles `AGENT-SETUP.md` step now sets them in the same command as `brew bundle`, and
     asks before any brew run on the Mini.
   - `tool-update-check` stays report-only.

## Evidence (run on the Mini)

| Check | Official v24.20.0 (kept) | Official v24.22.0 (removed) |
|---|---|---|
| Dive full release gate on `main` (`/tmp` `--shared` clone of the publisher) | exit 0, 65 audit files, 134 syntax checks, 0 failures, 0 drift | exit 0, 65 files, 0 failures, 0 drift |
| The same gate with `6eb28a7` | exit 0, 66 audit files, 135 syntax checks, 0 failures, 0 drift | exit 0, 66 files, 0 failures, 0 drift |
| hinterlands `npm test` | 0 failures | 0 failures |
| content-os `better-sqlite3` | loads (SQLite 3.53.2) | loads |
| content-os `tsc --noEmit` | not run | 0 errors |

- hinterlands `control:validate` fails only on vault drift (undeclared `Projects/Sienna Purchase
  2026`), on any Node.
- content-os `vitest run` gives 10 failures (`authorization_verification_due`,
  `analytics_policy_revalidation_required`), the same 10 on Homebrew's node@24 24.20.0. They are
  fixture dates, not the runtime.
- The Mini session separately checked OpenClaw's native modules, qmd's `better-sqlite3` and
  `node:sqlite` FTS5 on v24.20.0.

## Applied (2026-10-18, Phoenix time)

| When | What | Proof |
|---|---|---|
| 11:10 | The Mini session restarted the gateway with Tommy present. It now runs the official v24.20.0. node@24 was uninstalled and the `libsimdjson.33` stopgap removed. | `lsof -d txt` on the gateway PID shows `~/.local/share/node/node-v24.20.0-darwin-arm64/bin/node` |
| 11:01 | `6eb28a7`, source-only push: every Dive child runs on the scheduled Node, and scheduler-watch probes each core job's runtime. | pre-push gate: 66 audit files, 0 failures, 0 drift; the 12:15 recovery ran it and published `09fb307` (production matches all 25 public files) |
| 12:27 | `/opt/homebrew/etc/homebrew/brew.env` with the five guards. | `env -i … brew config` lists all five as set |
| 12:28–12:36 | 38 job commands moved from `/opt/homebrew/bin/node` to `~/.local/bin/node`, one `openclaw cron edit` at a time. That was 26 argv entries, 9 `sh -lc` strings, 2 script payloads (the transcript mirror reinstalled verbatim from this repo, and tool-update-check) and 1 trigger script (warboard-ops-alerts). | each before/after diff changed only that field, plus OpenClaw's `configRevision`; afterwards 0 of 116 jobs name `/opt/homebrew/bin/node` and 39 name `~/.local/bin/node` |
| 12:39 | The `runtime-watchdog` job (`b4744563…`) goes live: every 5 minutes, Tommy's DM, failure alert after 1 run. It is installed verbatim from `runtime-watchdog-cron-script.js`. | a forced run with delivery off came back `ok` and quiet; the installed script is byte-identical to the file |
| 12:40 | Dead-runtime proof: a throwaway command job whose Node does not exist. | the run failed with `ENOENT`, and OpenClaw's failure alert reached Tommy's DM at 12:40:17 with no Node involved; the job was deleted |
| 12:40 | Watchdog proof on the real gateway: a throwaway copy pointed at a missing Node, delivery off. | its run printed "The Node every scheduled job runs (…node-missing-test) will not start on the Mini (exit 127 …)"; the copy was deleted |
| 12:42 | `brew upgrade --dry-run` with `brew.env` in force. | it would upgrade 65 packages and install 6 dependencies, none of them Node or anything under `~/.local/share/node`; `FETCH_HEAD` unchanged (no auto-update) |

**Test messages Tommy received from the watchdog's setup, none of them a real problem:**

- **12:30:08:** the first forced run failed because no owning agent was set; its failure alert went out.
- **12:30:25:** "… is no longer scheduled" for all five core jobs. The script's `automations` tool lists only caller-visible jobs.
- **12:37:** "The OpenClaw gateway … cannot start commands". The gateway's exec refuses `sqlite3` on its state directory.

Both causes are fixed and locked by tests. The watchdog now lists jobs with
`openclaw gateway call cron.list`, run on the scheduled Node and filtered by the system python3.
Later test runs kept delivery off.

**Left as they are, by decision:**

- **Seven LaunchAgents and wrappers** still start `/opt/homebrew/bin/node`: story-canvas,
  capture-relay, warboard-watch, warboard-watchdog, xapi-proxy, agent-bridge and
  community-discord. That link points at the same official build. Moving them means a launchd
  restart (and its one refused start), so each moves when next edited. The watchdog alerts if
  that link stops resolving to the approved build.
- **OpenClaw `env.vars`:** the guard values for the gateway's own environment are staged.
  `gateway.reload.mode` is `off`, so they would apply only at the next restart, and `brew.env`
  already governs every brew run.
- **warboard-ops-alerts:** its source file in the production-warboard repo
  (`scripts/launchd/README.md`) still shows the old trigger path. The live job was edited; the
  file needs the same one-word change.

## Follow-ups

- yt-dlp (Homebrew Python), xurl, git and cloudflared are still Homebrew binaries; `brew.env`
  stops unattended upgrades of them, and the transcript and snapshot steps already treat a
  refused yt-dlp download as waiting.
- The hand-made `libsimdjson.33` link inside the 5.0.5 keg stays until the gateway restart (the
  running gateway's command helper re-launches node@24). After that it is removed, or node@24 is
  reinstalled properly, once nothing runs node@24.
- `~/.local/bin/npm` and `npx` still link to Homebrew's node@24 (interactive use only).
- The OpenClaw gateway restart, which moves the running gateway and its command helper off Homebrew's node@24 onto the official build, waits for Tommy.
