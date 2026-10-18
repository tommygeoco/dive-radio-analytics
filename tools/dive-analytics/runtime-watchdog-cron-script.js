// OpenClaw native script payload: the Hinterlands runtime watchdog (2026-10-18,
// audit/AUDIT-2026-10-18-homebrew-node.md).
// Installed verbatim with `openclaw cron edit <id> --script -`, so the tested
// source and the scheduled source cannot drift. Runs every five minutes with no
// model turn. One `/bin/sh` command (through the gateway's command helper)
// starts each Node with `-v`, counts brew.env's guards, and lists the
// automations with `openclaw gateway call cron.list` on the scheduled Node,
// filtered by the system /usr/bin/python3. (The script's own `automations` tool
// lists only caller-visible jobs, which leaves out the operator-created Dive
// jobs, and the gateway's exec refuses sqlite3 on its state directory.) A
// gateway that cannot start the command at all is reported too; when the
// scheduled Node is dead, its alert stands in for the job list. OpenClaw
// supplies exec, process and trigger.
//
// Why: on 2026-10-18 an unattended Homebrew run broke /opt/homebrew/bin/node
// at 01:18. Every Node job died in dyld for eight hours, the Dive Radio alert
// job was switched off after ten failures, and the Node-based guard
// (scheduler-watch) could not run either. This job says so in Slack within ten
// minutes:
//   - a Node the jobs use will not start (`<node> -v` fails);
//   - ~/.local/bin/node (every scheduled job and the gateway) or
//     /opt/homebrew/bin/node (seven LaunchAgents and wrappers) no longer resolves
//     into the approved official build or prints its version (an installer or
//     a `brew link` replaced the link);
//   - /opt/homebrew/etc/homebrew/brew.env no longer stops unattended brew
//     changes (auto-update, upgrades, dependents check, cleanup, autoremove);
//   - the gateway cannot start a command at all (the probe itself fails);
//   - a core job is switched off (auto-disabled or by hand), or another job was
//     auto-disabled in the last day.
// Each problem is said once, again every six hours while it lasts, and once
// more when it clears. Returned state carries what was said.

const SCHEDULED_NODE = "/Users/bones/.local/bin/node";
const APPROVED_DIR = "/Users/bones/.local/share/node/node-v24.20.0-darwin-arm64/";
const APPROVED_VERSION = "v24.20.0";
const RUNTIMES = [
  ["the Node every scheduled job runs", SCHEDULED_NODE],
  ["Homebrew's node link, which seven LaunchAgents and wrappers still start", "/opt/homebrew/bin/node"],
];
const BREW_ENV = "/opt/homebrew/etc/homebrew/brew.env";
const OPENCLAW_CLI = "/opt/homebrew/bin/openclaw"; // a JS file: run by SCHEDULED_NODE, not its shebang
const CORE = {
  "c4bc213f-7437-4a80-9c91-8af216cd6fab": "the 07:00 Dive Radio daily run",
  "34741aa2-342e-454e-9eea-30fff2b92c18": "the 08:15/12:15 Dive Radio recovery check",
  "a8c0d4a8-22e2-4583-9c07-ce5715e85ceb": "Dive Radio Slack alert delivery",
  "65eca218-a7be-4788-af4b-72dbe85afa37": "the 06:50 Restream ingest",
  "84781eb0-d195-4203-a13a-026f4b453eeb": "the 08:00 Dive Radio transcript mirror",
};
const REMIND_MS = 6 * 60 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const told = { ...(trigger?.state?.told ?? {}) };
const names = { ...(trigger?.state?.names ?? {}) }; // auto:<id> → job name, for its "cleared" line
const problems = new Map(); // key → line
const capital = (text) => `${text[0].toUpperCase()}${text.slice(1)}`;

// 1. One shell command. Rows: path|exit|first line of -v|resolved path (a dead
//    Node prints the loader's first line); brew.env|<guards set>;
//    jobs-read|<count>; job|id|name|enabled|autoDisabledAtMs|errors|last error
//    for each core job and every job auto-disabled in the last day.
const sq = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
// Core jobs, plus jobs already reported as switched off (to say when they clear).
const watchIds = [...new Set([...Object.keys(CORE), ...Object.keys(told).filter((key) => key.startsWith("auto:")).map((key) => key.slice(5))])]
  .filter((id) => /^[0-9a-f-]{36}$/.test(id)).join(",");
// Reads cron.list JSON on stdin; prints jobs-read|<count>[|more] and one job row
// per watched id or job auto-disabled since <since>.
const FILTER = [
  "import json, sys",
  "raw = sys.stdin.read()",
  "try:",
  "    d = json.loads(raw[raw.find('{'):], strict=False); jobs = d['jobs']",
  "except Exception:",
  "    sys.exit(0)",
  "watch = set(sys.argv[1].split(',')); since = int(sys.argv[2])",
  "print('jobs-read|%d%s' % (len(jobs), '|more' if d.get('hasMore') else ''))",
  "for j in jobs:",
  "    st = j.get('state') or {}; a = st.get('autoDisabled') or {}",
  "    if j.get('id') in watch or (not j.get('enabled') and (a.get('atMs') or 0) > since):",
  "        err = ' '.join(str(st.get('lastError') or '').split())[:140].replace('|', '/')",
  "        print('job|%s|%s|%d|%s|%s|%s' % (j['id'], str(j.get('name', '')).replace('|', '/'), 1 if j.get('enabled') else 0, a.get('atMs') or '', a.get('consecutiveErrors') or '', err))",
].join("\n");
const listJobs = `'${SCHEDULED_NODE}' '${OPENCLAW_CLI}' gateway call cron.list --json --timeout 30000 --params ${sq(JSON.stringify({ includeDisabled: true, includeDeliveryPreviews: false, limit: 200 }))} 2>/dev/null | /usr/bin/python3 -c ${sq(FILTER)} ${sq(watchIds)} ${sq(String(now - RECENT_MS))}`;
const quoted = RUNTIMES.map(([, path]) => `'${path}'`).join(" ");
let probe;
try {
  probe = await exec({
    command: `for n in ${quoted}; do out=$("$n" -v 2>&1); rc=$?; real=$(/bin/realpath "$n" 2>/dev/null); printf '%s|%s|%s|%s\\n' "$n" "$rc" "$(printf '%s' "$out" | head -1)" "$real"; done; c=$(grep -cE '^HOMEBREW_NO_(AUTO_UPDATE|INSTALL_UPGRADE|INSTALLED_DEPENDENTS_CHECK|INSTALL_CLEANUP|AUTOREMOVE)=1$' '${BREW_ENV}' 2>/dev/null); printf 'brew.env|%s\\n' "\${c:-0}"; ${listJobs}`,
    timeoutSeconds: 60,
    yieldMs: 30000,
  });
  // A loaded gateway can background the probe; wait for it like tool-update-check does.
  for (let poll = 0; probe?.status === "running" && poll < 3; poll++) {
    probe = await process({ action: "poll", sessionId: probe.sessionId, timeout: 20000 });
  }
} catch (error) {
  probe = { error };
}
const probeText = String(probe?.aggregated ?? probe?.stdout ?? probe?.output ?? "");
const probeExit = Number.isInteger(probe?.exitCode) ? probe.exitCode : Number.isInteger(probe?.code) ? probe.code : null;
const lines = probeText.split("\n").map((line) => line.split("|"));
const rows = new Map(lines.filter((parts) => parts.length >= 4 && parts[0].startsWith("/")).map((parts) => [parts[0], { rc: Number(parts[1]), said: parts.slice(2, -1).join("|").trim(), real: parts.at(-1).trim() }]));
const brewGuard = lines.find((parts) => parts[0] === "brew.env" && parts.length === 2);
const jobsRead = lines.find((parts) => parts[0] === "jobs-read" && parts.length >= 2);
const listRead = Boolean(jobsRead) && Number(jobsRead[1]) > 0;
const partialList = jobsRead?.[2] === "more"; // more than one page: a core job off this page is not "missing"
const jobs = lines.filter((parts) => parts[0] === "job" && parts.length >= 7).map(([, id, name, enabled, atMs, errors, ...last]) => ({ id, name, enabled: enabled === "1", atMs: Number(atMs) || 0, errors: errors || "repeated", lastError: last.join("|").trim() || "unknown" }));
if (probe?.error || rows.size !== RUNTIMES.length || !brewGuard) {
  const why = String(probe?.error?.message ?? probe?.error ?? (probeText.trim().split("\n").at(-1) || `exit ${probeExit ?? "unknown"}`)).slice(0, 200);
  problems.set("gateway:exec", `The OpenClaw gateway on the Mini cannot start commands (${why}), so every command and script job fails before it runs. A human gateway restart may be needed; read /tmp/openclaw/openclaw-<date>.log first.`);
} else {
  for (const [label, path] of RUNTIMES) {
    const row = rows.get(path);
    if (row.rc !== 0 || !/^v\d+\./.test(row.said)) {
      const said = row.said.replace(/^dyld\[\d+\]:\s*/, "").slice(0, 160);
      problems.set(`runtime:${path}`, `${capital(label)} (${path}) will not start on the Mini (exit ${row.rc}${said ? `: ${said}` : ""}). Every job that names it fails before it runs; \`${path} -v\` on the Mini shows the error.`);
    } else if (row.said !== APPROVED_VERSION || !row.real.startsWith(APPROVED_DIR)) {
      problems.set(`moved:${path}`, `${path} (${label}) now resolves to ${row.real || "an unknown path"} (${row.said}), not the approved official ${APPROVED_VERSION} build under ${APPROVED_DIR}. Something replaced the link, and whatever starts it next runs that Node. Point it back with \`ln -sfn ${APPROVED_DIR}bin/node ${path}\`, or approve the new build.`);
    }
  }
  if (Number(brewGuard[1]) !== 5) {
    problems.set("brew-env", `${BREW_ENV} no longer sets all five HOMEBREW_NO_* guards (${Number(brewGuard[1]) || 0} of 5), so a brew run can again auto-update, upgrade or remove what nobody asked it to.`);
  }
  // The list must answer. With a dead scheduled Node its runtime alert stands in;
  // otherwise an unreadable list is a run failure (failure alert), never silence.
  if (!listRead && !problems.has(`runtime:${SCHEDULED_NODE}`)) {
    throw new Error("The runtime watchdog could not read the automation list (openclaw gateway call cron.list).");
  }
}

// 2. Switched-off jobs: core jobs by id; any other job OpenClaw auto-disabled in the last day by name.
if (listRead) {
  for (const [id, label] of Object.entries(CORE)) {
    const job = jobs.find((item) => item.id === id);
    if (!job && partialList) continue;
    if (!job) problems.set(`core:${id}:missing`, `${capital(label)} is no longer scheduled in OpenClaw (job ${id}).`);
    else if (!job.enabled) {
      problems.set(`core:${id}:off`, job.atMs
        ? `OpenClaw switched off ${label} after ${job.errors} failed runs in a row (last error: ${job.lastError}). Fix the cause, then \`openclaw cron enable ${id}\`.`
        : `${capital(label)} is switched off in OpenClaw; it will not run until someone switches it back on (\`openclaw cron enable ${id}\`).`);
    }
  }
  for (const job of jobs.filter((item) => !CORE[item.id] && !item.enabled && item.atMs && now - item.atMs < RECENT_MS)) {
    names[`auto:${job.id}`] = job.name;
    problems.set(`auto:${job.id}`, `OpenClaw switched off ${job.name} after ${job.errors} failed runs in a row (last error: ${job.lastError}).`);
  }
}

// 3. Say what is new, what is still wrong after six hours, and what cleared.
const said = [];
for (const [key, line] of problems) {
  if (!told[key] || now - told[key] >= REMIND_MS) { said.push(line); told[key] = now; }
}
for (const key of Object.keys(told)) {
  if (problems.has(key)) continue;
  const [kind, id, what] = key.split(":");
  const job = jobs.find((item) => item.id === id);
  if (kind === "runtime") said.push(`Cleared: ${key.slice(8)} starts again.`);
  else if (kind === "moved") said.push(`Cleared: ${key.slice(6)} is the approved ${APPROVED_VERSION} build again.`);
  else if (key === "brew-env") said.push(`Cleared: ${BREW_ENV} sets all five guards again.`);
  else if (key === "gateway:exec") said.push("Cleared: the gateway can start commands again.");
  else if (kind === "core" && !listRead) continue; // unread list: keep the problem until it can be checked
  else if (kind === "core" && what === "missing") said.push(`Cleared: ${CORE[id] ?? id} is scheduled again.`);
  else if (kind === "core") said.push(`Cleared: ${CORE[id] ?? id} is switched on again.`);
  else if (kind === "auto") {
    if (!listRead) continue;
    if (!job) said.push(`Cleared: ${names[key] ?? id} is gone from the schedule.`);
    else if (job.enabled) said.push(`Cleared: ${names[key] ?? job.name} is switched on again.`);
    // still off after a day: it was said (and reminded); stop repeating it
  }
  delete told[key];
  delete names[key];
}
return said.length
  ? { notify: `Runtime watchdog (Hinterlands Mini)\n${said.map((line) => `• ${line}`).join("\n")}`, state: { told, names } }
  : { state: { told, names } };
