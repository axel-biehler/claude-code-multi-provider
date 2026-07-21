# Phase 0 Spike — Results (2026-07-17)

## Outcome: ✅ Definition of Done met

Full round-trip proven once, end to end:
`delegate_task` (MCP) → git worktree → CLI worker → diff → orchestrator validation
(22/22 tests + tsc in the worktree) → commit in worktree → fast-forward merge → cleanup.

- **Winning worker:** `claude -p` (Sonnet, user's Team seat) — **212s**, exit 0, exactly the
  2 requested files, 55 insertions, all acceptance criteria satisfied.
- **Codex worker:** ✅ also proven end-to-end. Initially blocked by an exhausted free-account
  quota; after the user subscribed, a rerun produced `titleCase` + tests in **105s**, exit 0,
  validated and merged. Default engine (`DELEGATE_ENGINE` unset) now routes to Codex and works.

## Both subscription engines validated

| Engine | Invocation | Proof |
|--------|-----------|-------|
| Codex (`codex exec`, ChatGPT plan) | default (`DELEGATE_ENGINE` unset) | titleCase, 105s |
| Claude (`claude -p`, Team seat) | `DELEGATE_ENGINE=claude` | slugify, 212s |

## Findings (each burned one real run)

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | Codex hung the full 600s, zero events | `codex exec` treats an **open stdin pipe** as extra instructions and blocks until EOF (`Reading additional input from stdin...`) | `stdio: ['ignore','pipe','pipe']` |
| 2 | `node_modules` symlink polluted the diff | `.gitignore` `node_modules/` (dir pattern) doesn't match a **symlink** | drop trailing slash |
| 3 | Test count doubled (30) | vitest crawled test files inside kept worktrees under `.delegate/` | `vitest.config.ts` exclude |
| 4 | Claude worker instant **401 invalid credentials** | Child inherited the parent Claude Code session's `ANTHROPIC_BASE_URL` proxy + `CLAUDE_CODE_*` markers | strip `ANTHROPIC*`/`CLAUDE*` from worker env (`sanitizedWorkerEnv`) |
| 5 | Then **401 token revoked** | Standalone CLI's Keychain OAuth token was stale/revoked (desktop app re-auth) | user ran `claude setup-token` (one-time) |
| 6 | Worker couldn't run its tests | `--allowedTools 'Bash(npx vitest *)'` didn't take effect in `-p` mode — Bash stayed gated; worker hand-traced logic instead | needs correct pattern/permission combo in Phase 1; orchestrator-side validation covered it |

Also observed: the user's personal `~/.codex/config.toml` spins up their MCP servers (Obsidian)
inside every delegated codex job — noise + latency.

## Validated design decisions

- **Distiller works:** 600s hang, quota error, both 401s all came back as clean one-line
  summaries + artifacts on disk — the orchestrator context never saw raw logs.
- **Worktree isolation works:** 4 failed runs left `main` untouched; cleanup (`removeWorktree`
  + branch delete) leaves zero debris.
- **Orchestrator validation is not optional:** finding 6 proves the worker can't always
  self-verify — the Claude-reviews-diff-and-runs-tests step caught nothing wrong this time but
  is the safety net the architecture depends on.
- **Engine seam works:** swapping codex→claude was an env var (`DELEGATE_ENGINE=claude`), zero
  caller-visible change — the "Claude doesn't know which engine" property held in practice.

## Known limitations (accepted for the spike)

- **Sync tool call**: one shot, blocks until done — Phase 1's async job queue is mandatory
  (600s runs sit at the edge of MCP client timeouts).
- **M2 (review):** the `node_modules` **symlink** into the worktree lets a worker write through
  to shared deps under `--sandbox workspace-write`; diff won't show it. Phase 1: read-only
  mount/copy, or per-job installs.
- Successful-job worktrees are kept by design (review), but there's no retention/GC policy yet.
- Worker engines/models are hardcoded (`sonnet`, budget $2) — policy.yaml in Phase 1.
- Codex jobs should run with an **isolated `CODEX_HOME`** (no personal MCP servers/config).

## Phase 1 backlog (from evidence)

1. Async job queue (`delegate_task` → job_id; `check_delegations`; `get_delegation_result`). — ✅ done (Phase 1, 2026-07-17)
2. policy.yaml router replacing `DELEGATE_ENGINE` + quota ledger (finding: quota exhaustion is
   a *routing* signal, not just an error). — ✅ done (Phase 1, 2026-07-17)
3. Preflight upgrade: auth ≠ usable — probe quota/token validity, not just `login status`. — ✅ done (2026-07-18): `npm run preflight` probes each policy-chain engine live (`--no-probe` for static-only); measured floor: a minimal `claude -p` costs ~$0.41 to boot, so the probe budget is $1.
4. Fix worker test-execution permissions (finding 6); isolated `CODEX_HOME`; read-only deps. — ✅ done (2026-07-18): allowedTools use the colon grammar `Bash(npx vitest:*)` (space-form was silently invalid) **plus `Bash(rtk …:*)` duplicates** — the worker inherits the user's `~/.claude` PreToolUse hook, which rewrites `npx vitest` → `rtk vitest`, and permissions evaluate the rewritten command (an isolated `CLAUDE_CONFIG_DIR` was probed and loses auth: "Not logged in"); `CODEX_HOME` isolation replaced by `-c mcp_servers={}` (auth.json lives in CODEX_HOME — isolating it would orphan subscription auth); deps provisioned as an APFS clone (copy-on-write) instead of a symlink, closing the M2 write-through.
5. Worktree retention policy + GC command. — ✅ done (Phase 1, 2026-07-17)
