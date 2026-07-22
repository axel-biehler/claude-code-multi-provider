# claude-code-multi-provider

Delegate MCP server: **Claude Code stays the orchestrator** (plan, decompose, validate) and
delegates bounded implementation subtasks to subscription-CLI workers via an async 4-tool
surface (`delegate_task`, `check_delegations`, `get_delegation_result`, `configure_delegation`)
that hides which engine runs. Personal project.

## Source of truth (read these first)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — full design, strategy comparison, extension-point research.
- [docs/PHASE0-RESULTS.md](docs/PHASE0-RESULTS.md) — spike results, 6 operational findings (all 5 backlog items now ✅).
- [docs/PHASE1-RESULTS.md](docs/PHASE1-RESULTS.md) — Phase 1 outcome, session findings.
- [docs/PHASE2-RESULTS.md](docs/PHASE2-RESULTS.md) — Phase 2 outcome, findings 1-7, **current fresh-session checklist** and Phase 3 backlog.

## Status
Phase 1 complete (all 5 PHASE0-RESULTS backlog items): async job queue (`delegate_task`
returns a `job_id` immediately; poll `check_delegations`; fetch `get_delegation_result`),
`policy.yaml` router (replaces `DELEGATE_ENGINE`), quota ledger (`.delegate/quota-ledger.json`),
worktree GC (`npm run gc`), live preflight probes (`npm run preflight`), hardened workers
(test-exec permissions, MCP-free codex config, cloned deps).
Phase 2 complete on the feasible items: boot visibility (`check_delegations` →
`{server:{bootedAt,gitRev},jobs}`), quota cooldowns honoring vendor reset signals,
escalation on reject (`parent_job_id`/`feedback`/`escalate` on `delegate_task`),
`delegation-manager` subagent, per-server MCP isolation + timed-out-exit unmasking.
Antigravity (`agy`) is implemented as a third engine (`src/engines/antigravity.ts`), wired
through policy/routing/detect/preflight/configure and opt-in via the `policy.yaml` chain.
LiteLLM `api` tier remains designed, awaiting user keys — see PHASE2-RESULTS.

## How to test
```bash
npm run preflight                          # env gate + LIVE quota/token probe per chain engine
npm run preflight -- --no-probe            # static checks only (no real requests)
npm run e2e -- --list-only                 # smoke: server boots + lists the 4 tools (no LLM)
npm run e2e -- examples/example-task.json  # full async round-trip: submit → poll → result
npm run gc -- --dry-run                    # preview worktree/job cleanup per retention policy
```
The harness submits the task (instant `job_id`), polls every 5s printing status changes, then
prints the summary + diff. It **keeps** the worktree (`.delegate/worktrees/<jobId>`) and branch
`delegate/<jobId>`; merge is manual (orchestrator's job by design).
Engine selection: copy `policy.example.yaml` → `policy.yaml` (gitignored) and edit `chain`
(e.g. `chain: [claude]`); absent file = defaults (codex first).

## Layout
- `src/server.ts` — thin boot entry (the MCP registration referenced by the app config;
  keep this path stable). Tool surface lives in `src/mcp/tools.ts` (`registerDelegateTools`,
  `resolveRevision`, payload helpers).
- Domains: `src/jobs/` (store, executor, paths) · `src/routing/` (policy, router, quota) ·
  `src/engines/` (codex, claude, antigravity + `shared/` worker-process, failure-signals, prompt — shared
  infra lives here, never inside one engine) · `src/git/` (worktree, gc) · `src/types.ts`
  (cross-domain contract, single file by design).
- `src/playground/` — target area for delegated example tasks (e2e smoke), NOT product code.
- `tests/` mirrors the domain layout.

## Conventions & gotchas
- TS ESM strict, `moduleResolution: bundler` → **no `.js` suffix** on local imports (SDK subpaths
  like `@modelcontextprotocol/sdk/server/mcp.js` DO keep `.js`). Vitest 4, node ≥ 20.
- `src/server.ts` is a stdio MCP server: **stdout is the JSON-RPC channel — never `console.log`**;
  logs go to stderr only.
- Workers run in a git worktree; the tool returns a distilled summary + diff, full logs to
  `.delegate/jobs/<id>/` (gitignored).
- Worker env is rebuilt from a **strict allow-list** (`buildWorkerEnv`, `src/engines/shared/`):
  only `PATH`/`HOME`/`CODEX_HOME`/locale vars pass, so parent-session vars (`ANTHROPIC*`/`CLAUDE*`)
  can't 401 the child and unrelated shell secrets (`OPENAI_API_KEY`/`GH_TOKEN`/`AWS_*`/…) never
  reach a worker; auth resolves from disk (`~/.codex/auth.json`, `~/.claude` via `HOME`). Extend
  the allow-list — never fall back to a blanket inherit. Never leave a child CLI's
  stdin as an open pipe (codex blocks on it, claude stalls 3s) — `stdio: ['ignore',…]` or EOF it.
- Claude-worker `--allowedTools` rules use the **colon grammar** (`Bash(npx vitest:*)`) —
  space-form patterns are silently ignored (Phase-0 finding 6). The worker also **inherits the
  user's `~/.claude` hooks** (a pristine `CLAUDE_CONFIG_DIR` loses auth: "Not logged in"), and
  the RTK hook rewrites `npx vitest` → `rtk vitest` with permissions evaluated on the REWRITTEN
  command — hence the `Bash(rtk …:*)` duplicates in `WORKER_ALLOWED_TOOLS`. A bare `claude -p`
  boot costs ~$0.41 (CLI system prompt) — keep `maxBudgetUsd` well above it.
- Codex workers disable every personal `~/.codex` MCP server **per entry** (`codex mcp list
  --json` → `-c mcp_servers.<name>.enabled=false` each): the blanket `-c mcp_servers={}` is a
  deep-merge **no-op** on codex 0.144.x (Phase-2 finding 6) and MCP server processes run
  outside the worker sandbox. Worktree `node_modules` is an **APFS clone** (worker writes
  stay private), symlink only as non-APFS fallback.
- Antigravity workers use `agy -p --output-format json`; the final message is `response` and
  success is `status === "SUCCESS"`. Always pass `--print-timeout` (its 5m default is shorter
  than a job) and `--dangerously-skip-permissions` (non-TTY autonomy). **`--add-dir <worktree>`
  is mandatory**: `agy` resolves its workspace from `--add-dir`, NOT cwd — with an empty
  workspace a headless `-p` run writes into its own `~/.gemini/antigravity-cli/scratch` (or a
  stale registered workspace), so files escape the worktree and `collectDiff` returns empty.
  Auth resolves through `HOME` from `~/.gemini`/keyring, so `buildWorkerEnv` needs no new
  allow-list key. There is no per-invocation MCP-disable flag: personal MCP servers in
  `~/.gemini/settings.json` are not isolated beyond the worktree, sanitized env and timeout
  guard; bespoke isolation is a follow-up.
- Personal project: public npm registry pinned in `.npmrc`; **never** use a private/corporate registry.
- Engine selection lives in the `policy.yaml` router (chain + per-engine quotas); quota/auth
  failures reroute to the next engine. Keep results engine-neutral ("delegated worker", not
  the engine name).
- Worker model = `workers.<engine>.model`, or an optional per-effort tier map
  `workers.<engine>.models.{light,standard,heavy}` chosen by `delegate_task`'s engine-neutral
  `effort` hint (`resolveWorkerModel` in `src/routing/router.ts`, precedence
  `models[effort ?? 'standard'] ?? model`). No tiers + no effort = the scalar model (backward
  compatible). `configure_delegation` writes both forms; keep `effort` engine/model-agnostic.
- Jobs are session-scoped: a server restart forgets in-flight jobs; the quota ledger persists
  across restarts.
- Commits: conventional format, no attribution trailer.
