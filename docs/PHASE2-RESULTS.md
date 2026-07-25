# Phase 2 — Results (2026-07-18)

## Outcome

Backlog from PHASE1-RESULTS §Phase 2, in feasibility order. Every implementation task was
delegated to workers (dogfooding); the orchestrator kept design, validation, docs and merges.

| # | Item | Status |
|---|------|--------|
| 6 | Boot visibility (banner rev + `check_delegations` server info) | ✅ `0cd2438` |
| 3 | `delegation-manager` subagent | ✅ `3afa9ae` (`.claude/agents/delegation-manager.md`) |
| 5 | Ledger honors vendor reset signals (`parseRetryAt` → `markExhaustedUntil`) | ✅ `622323a` |
| 4 | Escalation on reject (`parent_job_id` + `feedback` + `escalate`) | ✅ `c48211d` (attempt 1 stalled → findings 6-7; attempt 2 clean, 542 s) |
| 1 | Third engine: Antigravity | ✅ shipped in Phase 3 — finding 1 resolved |
| 2 | LiteLLM API-fallback tier | 📐 designed, awaiting user input (keys/proxy) |

`check_delegations` now returns `{ server: { bootedAt, gitRev }, jobs: [...] }` — a breaking
shape change for consumers (e2e harness updated). Server staleness is now directly visible;
this **replaces** the Phase-1 "`check_delegations` → `[]` confirms a new process" heuristic.

## Session findings (observed live, none guessed)

1. **The installed `agy` (1.107.0) is the Antigravity IDE launcher** (VS Code fork:
   `--diff/--goto/--new-window`; its `chat` subcommand only drives the GUI). The actual
   headless agent CLI (`agy -p/--print`, `--headless` + `--approve` policies) is a separate
   install, absent on this machine, and the IDE symlink at
   `~/.antigravity/antigravity/bin/agy` would shadow/collide with it on PATH. Known issue to
   design around when it lands: `agy -p` can drop the final response on non-TTY stdout —
   spawned subprocesses are exactly that, so the adapter must not rely on stdout capture.
   Install + Google OAuth is a user decision → engine deferred.
2. **Worker verification claims can be stale.** The ledger job reported "`tsc --noEmit`:
   passed" but delivered 5 type errors (`match.index` is `number | undefined` in the lib
   typings); vitest alone doesn't typecheck, so its 129/129 was real but insufficient.
   Caught by the orchestrator's own pre-merge re-run. Consequences now baked in: delegate
   specs demand verification as the *final* step, and the fresh-session checklist requires
   re-running `tsc` + `vitest` in the worktree before any merge.
3. **The codex sandbox inherits the host's global `commit.gpgsign=true` but cannot reach
   the GPG keyring** — git-fixture tests fail inside worker sandboxes until neutralized
   (workers used `GIT_CONFIG_GLOBAL=/dev/null npx vitest run`). Backlog: bake a neutralized
   `GIT_CONFIG_GLOBAL` into the codex worker env so every job gets it for free.
4. **`src/server.ts` is now import-safe**: unit-testing the `check_delegations` payload
   helper required gating `main()` behind an `import.meta.url` entry guard — otherwise
   importing the module in vitest would boot the MCP server inside the test process.
   Smoke-verified under tsx (banner + tool listing unchanged).
5. **Parallel fan-out works end-to-end**: two disjoint jobs under `maxConcurrentJobs=2`,
   reviewed and ff-merged sequentially with zero conflicts (95 s + 479 s wall-clock,
   overlapped).
6. **`-c mcp_servers={}` is a NO-OP on codex 0.144.x** (deep-merge into the file config —
   proven offline: `codex mcp list` identical with and without the override). Every
   personal MCP server (docker gateway, 8× aws, an HTTP Obsidian entry) leaked into every
   job, and those server processes run OUTSIDE the worker sandbox. The first escalation
   job stalled at `turn.started` for its entire 20-min timeout while codex's rmcp client
   fought a dead LAN endpoint. Fix (`e9efb10`): enumerate `codex mcp list --json` and pass
   per-server `-c mcp_servers.<name>.enabled=false` — the only override form that
   verifiably disables an entry (Status flips to `disabled`; `enabled=false` entries do
   not boot).
7. **A timed-out worker can exit 0 on SIGTERM and read as success** (observed live:
   empty diff, no message, duration == timeoutMs, status `succeeded`). Fix (`e9efb10`):
   the timeout guard now reports firing and both adapters unmask a post-timeout exit 0
   to -1 (`unmaskTimedOutExit`), logging the termination to stderr.

## LiteLLM tier — design note (item 2, not built)

- **Vehicle:** reuse the claude adapter with env *injection*: keep the sanitized worker env,
  then set `ANTHROPIC_BASE_URL=<litellm endpoint>` + API key from a policy-named env var,
  model from policy. ToS-clean: API-key auth through a proxy is ordinary API usage — no
  subscription OAuth involved. (Alternative vehicle: codex `-c model_provider=...` config.)
- **Policy surface:** new engine name `api` usable in `chain`, `workers.api { baseUrl,
  model, apiKeyEnv, maxBudgetUsd }`, quotas like any engine. Preflight: endpoint
  reachability + key-env presence (no live spend).
- **Blocked on user input:** is a LiteLLM proxy meant to run persistently (binary exists at
  `~/.local/bin/litellm`; no config found), and which provider key(s) should fund the tier?

## Fresh-session checklist (supersedes Phase 1's)

- `policy.yaml` is local & gitignored; current local file sets `workers.codex.model` and a
  20-minute `workers.codex.timeoutMs` (large delegated jobs run 8–10+ min).
- After changing `src/` or `policy.yaml`: `pkill -f "tsx src/server.ts"` — the app respawns
  a fresh server on the next tool call; confirm via `check_delegations` → `server.gitRev`.
- `npm run preflight` before delegating (live probes; `--no-probe` static).
- **Before merging any delegated result: re-run `npx tsc --noEmit` AND `npx vitest run` in
  the worktree yourself.** Never trust the worker's claim (finding 2).
- Merge flow per job: commit in worktree → `git rebase main` → `git merge --ff-only` →
  remove worktree + delete branch → full suite on main.

## Phase 3 backlog

1. ✅ DONE — Antigravity engine shipped; only the per-invocation MCP-isolation follow-up remains.
2. LiteLLM `api` tier once keys/proxy questions are answered (design above).
3. Codex worker env: neutralized `GIT_CONFIG_GLOBAL` (finding 3).
4. Live trial of the `delegation-manager` subagent on a real multi-task batch.
5. Escalation follow-ups once item 4 is exercised for real: revision-of-revision chains,
   and whether `escalate` should also bias toward a policy-declared "stronger" order.

## Phase 3 — Antigravity engine (shipped)

The blocker in finding 1 is resolved: the real headless CLI `agy` 1.1.5 is installed at
`~/.local/bin/agy`, winning PATH over the IDE launcher symlink.

1. Real headless CLI at ~/.local/bin/agy (wins PATH; IDE launcher symlink is ~/.antigravity/antigravity/bin/agy).
2. `agy -p --output-format json` prints one JSON object: {conversation_id,status,response,duration_seconds,num_turns,usage}. Final message = response; success = status==="SUCCESS". Parser mirrors parseClaudeJson.
3. Auth resolves via HOME (data dir ~/.gemini, keyring) and SURVIVES the sanitized buildWorkerEnv (PATH/HOME/LANG only) — no new allow-list key needed. `agy models`: gemini-3.5-flash-{low,medium,high}, gemini-3.1-pro-{low,high}, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium.
4. `--app_data_dir=<empty>` breaks auth (exit 1) — not usable for isolation.
5. Personal MCP `aws-mcp` lives in ~/.gemini/settings.json; there is NO per-invocation MCP-disable flag (full flag set: add-dir, agent, continue, conversation, dangerously-skip-permissions, effort, log-file, mode, model, new-project, print, print-timeout, project, prompt, prompt-interactive, sandbox). Read-only print runs booted no MCP. Shipped without bespoke MCP isolation; worktree + sanitized env + timeout guard contain any stall; verify/close at e2e (follow-up).
6. `--print-timeout` default is 5 minutes (< a real job) — the adapter passes `--print-timeout=<ceil(timeoutMs/1000)>s`.
7. Tool autonomy via `--dangerously-skip-permissions` (not `--sandbox`).
8. Working dir via `cwd` (mirrors claude), `--add-dir` is the fallback lever.

Design decision: default chain stays [codex, claude]; antigravity is opt-in via policy.yaml.

## Phase 3 — Kimi Code engine (shipped, live validation pending login)

Fourth engine `kimi` (`src/engines/kimi.ts`), wired through the full surface like antigravity.
Spike findings against kimi-code v0.29.1 (`~/.kimi-code/bin/kimi`, official installer — a real
binary, so no Windows `.cmd`-shim concern):

1. Headless contract: `kimi -p <prompt> --add-dir <worktree> --output-format stream-json
   [--model=<id>]`. **`--yolo` and `--auto` are both rejected in `-p` mode** ("error: Cannot
   combine --prompt with --yolo.") — prompt mode takes no permission flag.
2. stdout is JSONL, OpenAI-chat-style (`{"role":"assistant","content":…}`, `tool_calls`,
   `role:"tool"`); thinking never appears; progress goes to stderr. Summary = last assistant
   message with non-empty text (string or `{type:"text"}` parts).
3. Documented exit codes: 0 success; 1 non-retryable (config/auth/quota); **75 retryable**
   (rate limit/5xx/timeout) → adapter maps unclassified exit-75 to the `quota` routing signal.
4. Logged-out failure (exit 1, stderr): "No model configured. Run `kimi` and use /login…" —
   misses the generic AUTH_PATTERN, hence the kimi-specific auth pattern in the adapter.
5. No timeout flag (armTimeoutGuard governs) and no reasoning flag: `workers.kimi` has no
   `reasoning` key, `ReasoningSchemaByEngine.kimi = null`, policy writes reject
   `reasoning.kimi`; kimi effort tiers use the per-effort `models` map only.
6. Auth = `kimi login` device flow; credentials in `~/.kimi-code/credentials/kimi-code.json`;
   `config.toml` starts empty and login populates managed provider/model entries
   (`parseKimiConfigModel` reads `default_model` for the catalog).
7. `~/.kimi-code/workspaces.json` is an agy-style workspace registry → `--add-dir` pins the
   worktree. No per-invocation MCP-disable flag (no `kimi mcp` subcommand in 0.29.1); same
   isolation posture as agy. `--skills-dir` exists as a future isolation lever.
8. Pending (blocked on `kimi login` by the operator): live probe, worktree-containment check,
   `buildWorkerEnv` auth confirmation, full `npm run e2e` with `chain: [kimi]`, and the
   plugin release. Static `npm run preflight -- --no-probe` and `npm run e2e -- --list-only`
   pass at rev d6cb0a1.

Design decision: default chain still [codex, claude]; kimi is opt-in via policy.yaml.
