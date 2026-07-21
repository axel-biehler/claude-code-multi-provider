# Phase 1 — Results & Handoff (2026-07-18)

## Outcome: ✅ Phase 1 complete, dogfooding operational

All 5 PHASE0-RESULTS backlog items shipped and **proven live**. The target loop now runs
end-to-end: orchestrator (Claude Code) → `delegate_task` → codex worker on **gpt-5.6-sol**
in an isolated worktree → distilled summary + diff → manual review → ff-merge.

Commit trail: `d18139e` (Phase 1 core) → `2dc7c6c`/`d7a442a` (kebabCase/camelCase, worker-built)
→ `b4f180e` (items 3-4) → `a7f0315` (**workers.codex.model — first fully dogfooded job**)
→ `ae5e14e` (example refresh) → `faeabb7` (snakeCase, worker-built on gpt-5.6-sol).
State: 111/111 tests, tsc clean, tree clean.

Proof of the final run (job `mrq1vyls-77ek`): `"model":"gpt-5.6-sol"` recorded in the codex
session log; 94s vs 348s pre-hardening (~3.7×); empty job stderr (personal MCP servers gone);
worktree `node_modules` is an APFS clone.

## Immediate todo (user)

- [ ] **Push**: no git remote configured. `gh` is logged in as `axel-biehler` (SSH). Run:
  `gh repo create claude-code-multi-provider --private --source . --remote origin --push`
  (or add a remote manually and `git push -u origin main`).

## Fresh-session checklist

- `policy.yaml` is **local & gitignored** — a fresh clone needs it recreated:
  ```yaml
  workers:
    codex:
      model: gpt-5.6-sol
  ```
- The delegate MCP server of a session runs the code loaded **at its boot**. After changing
  `src/` or `policy.yaml`: kill the `tsx src/server.ts` process — the app respawns a fresh one
  on the next tool call (verified 2026-07-18; `check_delegations` → `[]` confirms a new process).
- `npm run preflight` before delegating (live quota/token probes; `--no-probe` for static).

## Session findings (each observed live, none guessed)

1. **User-level hooks reach the claude worker.** The rtk PreToolUse hook rewrites
   `npx vitest` → `rtk vitest` and permissions evaluate the REWRITTEN command — hence the
   `Bash(rtk …:*)` duplicates in `WORKER_ALLOWED_TOOLS`. An isolated `CLAUDE_CONFIG_DIR`
   was probed and loses auth ("Not logged in") — not an option.
2. **A bare `claude -p` boot costs ~$0.41** (~69k cache-creation tokens of CLI system prompt).
   Any probe/worker budget must sit well above; probe cap is $1, worker default $2.
3. **Phase-0 finding 1 (open stdin pipe) also applies to probes** — every spawned CLI needs
   stdin ignored/EOF'd (codex blocks outright, claude stalls 3s then may misbehave).
4. **gpt-5.6-sol is a valid codex model id** (probe + real job, session-log proof).
5. Status-file watchers must match pretty-printed JSON (`"status": "…"` with a space).

## Phase 2 backlog (ARCHITECTURE.md §11 + session evidence)

1. **Third engine: Antigravity (`agy -p`)** behind the same adapter seam (config, not surgery).
   Treat as least-stable tier; validate JSON output handling (ARCHITECTURE §2-B).
2. **LiteLLM API-fallback tier** — genuine last resort after every subscription engine
   (priority order is the project's founding constraint).
3. **`delegation-manager` subagent** for batch fan-out + iterative validation loops
   (second-order context firewall, ARCHITECTURE §8).
4. **Escalation on reject**: re-delegate with reviewer feedback, optionally to a stronger
   engine (generate→evaluate loop, ARCHITECTURE §7).
5. **Ledger upgrade**: parse vendor rate-limit signals from worker stderr/events to set
   real cooldown timestamps instead of the fixed `exhaustionCooldownMinutes`.
6. QoL: boot banner with git rev in the server's stderr line (spot stale servers instantly);
   consider `check_delegations` exposing the server's boot time.

## Workflow (persisted in project memory, applies to future sessions)

Bounded implementation tasks → `delegate_task` first (dogfood + burns ChatGPT quota, not the
Claude session). Claude subagents for contract-locked orchestration waves and reviews.
Orchestrator keeps architecture, validation, docs, merges. Merge is always manual:
commit in worktree → rebase onto main → `git merge --ff-only` → remove worktree + branch.
