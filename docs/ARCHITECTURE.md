# Claude Code Multi-Provider Delegation Layer — Architecture

> **Status:** Implemented through Phase 2 — see `docs/PHASE0-RESULTS.md` … `docs/PHASE2-RESULTS.md`.
> This is the original design record; passages in future tense reflect design-time intent, not current gaps.
> **Date:** 2026-07-17
> **Author:** Architecture research (Claude Opus 4.8) + Axel Biehler
> **Scope of v1:** Single-user · local-only · TypeScript · Codex (`codex exec`) as the one delegate worker

---

## Purpose

Build an orchestration layer where **Claude Code remains the persistent "brain"** (planning,
architecture, repository understanding, task decomposition, final validation) and **delegates
bounded implementation subtasks to other AI engines** through a single MCP "delegate" tool that
**hides routing** from Claude.

Priority order for execution engines:

1. **Claude Team** subscription (the orchestrator — never delegated away)
2. **Existing authenticated CLIs** (Codex CLI, Antigravity CLI, …) on their own subscriptions
3. **Paid APIs** — last resort only

Claude decides *when* to delegate; the delegate layer decides *which backend* executes and returns
only a distilled result. Claude never loses control of the reasoning process.

---

## Table of contents

1. [Feasibility verdict](#1-feasibility-verdict)
2. [Three 2026 findings that reshape the plan](#2-three-2026-findings-that-reshape-the-plan)
3. [Research questions answered](#3-research-questions-answered)
4. [Subscription reality & ToS boundaries](#4-subscription-reality--tos-boundaries)
5. [Prior art](#5-prior-art)
6. [Strategy comparison](#6-strategy-comparison)
7. [Recommended architecture](#7-recommended-architecture)
8. [Where subagents fit](#8-where-subagents-fit)
9. [Risks & mitigations](#9-risks--mitigations)
10. [v1 — tailored build (Codex · TypeScript · local)](#10-v1--tailored-build-codex--typescript--local)
11. [Phased roadmap](#11-phased-roadmap)
12. [Sources](#12-sources)

---

## 1. Feasibility verdict

**Feasible.** Every link in the desired chain maps onto a supported Claude Code / MCP extension
point:

- Claude Code can invoke MCP tools (from the main agent **and** from subagents).
- An MCP server is just a program → it can spawn authenticated CLIs (`codex exec`, `claude -p`, …)
  as subprocesses and reuse their stored credentials.
- Git worktrees give clean per-task isolation and reviewable diffs for merge-back.
- Multiple delegations can run in parallel via an async job pattern.

The main risks are **operational** (ToS, rate limits, headless auth, validation cost) — **not
architectural**.

---

## 2. Three 2026 findings that reshape the plan

| # | Finding | Consequence |
|---|---------|-------------|
| **A** | **Claude subscription auth is first-party-binary-only.** Server-side block since **2026-01-09**, formalized in ToS **Feb 2026**. You may spawn the genuine `claude` binary on your own seat ("ordinary use"), but may **not** lift its OAuth token into the Agent SDK or a third-party client, and may **not** fan multiple users through one seat. | The "Claude" backend must be the real `claude -p` binary. Keep the system **single-user + local**. Reinforces keeping Claude Code as the interactive front-end. |
| **B** | **The consumer/subscription Gemini CLI was retired 2026-06-18.** No free Google-account tier or AI Pro/Ultra auth through it. Successor is **Antigravity CLI (`agy`)**; legacy Gemini CLI now needs a paid API key or Vertex/Code-Assist (enterprise). | A "Gemini" tier becomes **Antigravity CLI** (`agy -p`, Google-account OAuth, JSON still stabilizing) or a paid Gemini API key. Treat as the newest/least-stable worker — not a v1 anchor. |
| **C** | **MCP tool calls default to a ~60s timeout.** `MCP_TOOL_TIMEOUT` can raise it but is an *idle-between-progress* timer with open reliability bugs. Real coding tasks take **minutes**. | A synchronous "block until the CLI finishes" tool is fragile. Use the **async job/handle pattern**: `delegate_task` returns a `job_id` instantly; Claude polls. This one decision also solves parallelism and context bloat. |

**Net:** the two rock-solid subscription workers today are **`codex exec`** (ChatGPT plan) and
**`claude -p`** (your own Claude seat). Antigravity is a viable third. Paid APIs (via LiteLLM) are
the genuine last resort — exactly the original priority order, with corrected engines.

---

## 3. Research questions answered

| Question | Answer |
|----------|--------|
| **Can subagents invoke MCP tools?** | **Yes.** Subagents get tools via their `tools:` frontmatter (list `mcp__delegate__*`); omit it and they inherit everything. Nesting works up to 5 levels. Subagents can override the model. |
| **Can you delegate coding tasks through MCP?** | **Yes** — an MCP server spawns `codex exec` / `claude -p` / `agy` as subprocesses. Proven prior art: PAL MCP `clink`, `codex-mcp-server`. |
| **Can it invoke authenticated CLIs?** | **Yes.** Each CLI stores creds on disk/keychain (`~/.codex/auth.json`, Claude Keychain item) and a spawned subprocess reuses them with auto-refresh. Pre-provision long-lived tokens; don't rely on a runtime browser popup. |
| **Can context be preserved across delegated tasks?** | **Yes**, but the caller carries it: pass an objective + explicit file paths + acceptance criteria, and run the worker **in the repo (or a worktree)** so the sub-agent reads/edits files itself. Thread multi-step work with a `continuation_id`. |
| **Can results merge back into the conversation?** | **Yes.** Worker runs in a worktree → returns a **diff + concise summary** (full log offloaded to disk). Claude reviews, validates, then merges — or re-delegates with feedback. |
| **Can multiple delegated tasks run in parallel?** | **Yes**, via the async pattern: each `delegate_task` returns instantly and runs in its own worktree/process; Claude fires several, then polls. (Mutating MCP tools run *sequentially* within a turn unless `readOnlyHint:true`; the async "start" call is effectively read-only, so it parallelizes cleanly.) |

### Relevant Claude Code mechanics (verified, mid-2026)

- **Hooks** — 8 events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `Stop`, `SubagentStop`, `PreCompact`). `PreToolUse` can allow/deny/ask and
  **modify tool input**. Use them for *policy guardrails*, not reasoning-level delegation.
- **Headless** — `claude -p` with `--output-format json|stream-json`, `--json-schema`,
  `--model`, `--permission-mode`, `--allowedTools`, **`-w/--worktree`** (native worktree isolation),
  **`--max-budget-usd`**, `--fallback-model`, `--resume/--continue`.
- **Parallelism** — read-only tools (and MCP tools marked `readOnlyHint:true`) run concurrently; a
  single write/Bash call serializes the turn.
- **Context isolation** — subagents return only their final message; intermediate work stays out of
  the parent context. This is the "context firewall" the design leans on.
- **Permissions** — evaluation order: hooks → deny rules → ask rules → mode → allow rules →
  `canUseTool` callback. `allowedTools` does *not* constrain `bypassPermissions`.

---

## 4. Subscription reality & ToS boundaries

**Stay inside these lines** (why the design is single-user + local):

- ✅ **Allowed:** spawning the genuine `claude -p` on *your own* Claude Team seat for your own work
  ("ordinary, individual use"). Spawning `codex exec` on your own ChatGPT plan — OpenAI ships
  `codex exec` expressly for CI/cron/automation.
- ❌ **Prohibited:** extracting the Claude OAuth token into the Agent SDK or a custom client;
  routing *other users'* requests through your Pro/Max/Team credentials; multi-tenant fan-out on one
  seat. (OpenCode had to remove bundled Claude subscription support for exactly this reason.)
- ⚠️ **Operational caution:** subscription rate windows are **shared across surfaces**. A heavy
  automated `codex exec` loop competes with your interactive Codex/Claude usage and can exhaust the
  5-hour / weekly caps. Mitigate with a quota ledger, backoff, and budget caps.

---

## 5. Prior art

| Project | What it is | Relevance |
|---------|-----------|-----------|
| **PAL MCP** (formerly `zen-mcp-server`, BeehiveInnovations) | MCP server exposing other models as tools. Its **`clink`** subsystem spawns the actual CLIs (`gemini`, `claude`, `codex exec`) as MCP tools with role presets + context isolation. | **Closest blueprint.** Nails delegation + subscription-CLIs. Gap: the *caller* names the backend — no hidden router. Went quiet Dec 2025 → reference, not a dependency. |
| **claude-code-router** (musistudio) | Local proxy that reroutes Claude Code's own requests via `ANTHROPIC_BASE_URL`. | **Wrong layer** — replaces the reasoner wholesale (Claude silently becomes GPT/Gemini). Borrow its *routing/fallback/credential-pool concept*, reimplemented **inside** the delegate tool. |
| **LiteLLM** (BerriAI) | Unified API gateway; declarative fallback chains (`order=1→2→3`), cost tracking. API-key only — cannot present a subscription. | **Tier-3 API fallback only.** Good model for the API portion of the router. |
| **codex-mcp-server** (tuannvm) | Minimal TS MCP server wrapping `codex` CLI (inherits ChatGPT-plan auth). | **Cleanest per-backend template** for "wrap one subscription CLI as MCP tools." |
| **gemini-mcp-tool** (jamubc) | Wraps Gemini CLI; now defaults to the `agy` (Antigravity) backend post-deprecation. | Template for the Antigravity tier (Phase 2+). |
| **dmux / uzi / claude-squad / container-use** | Worktree/tmux/container multi-agent orchestrators. | **Complementary substrate** — adopt git-worktree-branch-per-task isolation and rebase/merge-back patterns. Not model delegation themselves. |

**Approach:** borrow PAL `clink`'s config-driven CLI presets + context isolation; graft a
claude-code-router-style hidden router on top; invert PAL's default so **CLI-subscription is tier 1,
API is fallback**. Drop PAL's dangerous auto-approve flags in favor of worktree isolation.

---

## 6. Strategy comparison

Evaluated against the invariant — *Claude stays the brain; routing is hidden; subscriptions before APIs.*

| Strategy | Keeps Claude as brain? | Hides routing? | Verdict |
|----------|:---:|:---:|---------|
| **A. Delegate MCP server (async jobs) + worktrees** | ✅ explicit hand-off | ✅ inside the tool | **RECOMMENDED** |
| B. `claude-code-router` proxy (`ANTHROPIC_BASE_URL`) | ❌ replaces reasoner | ✅ | Rejected — violates core premise |
| C. Hooks intercept Edit/Bash → redirect | ⚠️ fights the model | ⚠️ | Rejected — hooks are for policy, not reasoning delegation |
| D. Agent SDK custom orchestrator program | ✅ but rebuilds the front-end | ✅ | Overkill; can't use the Claude seat by ToS. Useful only to *build workers* |
| E. tmux/worktree fleets (dmux, claude-squad) | ✅ (human orchestrates) | ❌ human picks engine | Complementary substrate, not the router |

**Why A wins:** delegation is a deliberate, first-class act by Claude (not a silent swap); router
logic is fully encapsulated (Claude "doesn't know" the backend); it plugs into the existing
interactive Claude Code with zero workflow change. E becomes A's execution substrate; C's hooks
become A's policy guardrails.

---

## 7. Recommended architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  YOU (interactive)                                                     │
│        │                                                               │
│        ▼                                                               │
│  CLAUDE CODE  (Opus)  ── the brain: plan · decompose · validate        │
│        │  calls mcp__delegate__delegate_task(objective, files,         │
│        │        context, acceptance, hints)      ▲ returns diff+summary │
│        ▼                                          │                     │
│  ┌───────────────────────  DELEGATE MCP SERVER  ─┴──────────────────┐  │
│  │  (1) async JOB QUEUE   start → job_id (instant, non-blocking)     │  │
│  │  (2) ROUTER (hidden)   policy.yaml: task-type × size × quota →    │  │
│  │                        ordered tiers, circuit-breaker on 429      │  │
│  │  (3) ENGINE ADAPTERS   common execute(task)→result interface:     │  │
│  │        claude -p │ codex exec │ agy -p │ API(LiteLLM)             │  │
│  │  (4) ISOLATION         one git worktree per job                   │  │
│  │  (5) DISTILLER         full log→disk; return concise summary+diff  │  │
│  │  (6) QUOTA LEDGER      track 5h/weekly windows per backend         │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│        │ check_delegations() / get_result(job_id)                      │
│        ▼                                                                │
│  CLAUDE reviews diff → accept (git merge) │ reject → re-delegate w/ fb │
└──────────────────────────────────────────────────────────────────────┘
```

### Components

1. **Async job queue.** `delegate_task(...)` enqueues, spawns the worker detached, returns
   `{job_id, status:"running"}` in <1s — sidesteps the ~60s MCP timeout. `check_delegations()` and
   `get_delegation_result(job_id)` let Claude poll. Gives parallelism for free and keeps verbose
   output out of Claude's context.

2. **Hidden router** driven by an editable **`policy.yaml`** so Claude never sees backend identity
   and routing tunes without code changes. Start rule-based:
   - *Stays with Claude (never delegated):* architecture, cross-cutting reasoning, final validation.
   - *→ Codex:* well-specified implementation, tests, typed refactors.
   - *→ Antigravity/Gemini (later):* very-large-context reads, boilerplate/scaffolding.
   - *→ another `claude -p` worker (later):* Claude quality off the main context (parallel worktrees).
   - *→ API/LiteLLM (last resort):* only when every subscription tier is unavailable/exhausted.
   - Each tier has an **ordered fallback chain** + **circuit breaker** on rate-limit/error.

3. **Engine adapters** behind one interface — `execute(task) → {diff, summary, tests, exitCode}` —
   one small module per CLI (Strategy/Repository pattern). Adapters own CLI-specific flags and
   output parsing.

4. **Worktree isolation** — `git worktree add` per job (or `claude -p -w`). Parallel workers never
   collide; each produces a clean, reviewable diff.

5. **Distiller / context firewall** — full transcript + diff written to disk
   (`.delegate/jobs/<id>/`); the tool returns only a tight summary + the diff path. This is what
   makes "Claude stays the brain" hold *under token pressure*.

6. **Quota ledger** — track each backend's 5-hour/weekly windows so automated delegation doesn't
   starve the quota you rely on interactively, and routing prefers a backend with headroom.

### Validation loop (the payoff)

Worker generates → Claude reviews the diff against acceptance criteria, optionally runs tests →
**accept** (merge worktree) or **reject** (re-delegate with feedback, optionally *escalating* to a
stronger engine). This generate→evaluate loop is what makes delegating to cheaper models safe.

---

## 8. Where subagents fit

The subagent between Claude and the MCP tool is **optional, not mandatory**:

- **Default (small/medium tasks):** main Opus calls `delegate_task` directly. The distiller already
  provides the context firewall; an extra subagent hop just costs tokens and latency.
- **Use a `delegation-manager` subagent when:** a task needs many delegate calls + iterative
  validation (batch fan-out, long escalation loops). The subagent owns that messy back-and-forth in
  its own isolated context and returns one clean summary — a second-order context firewall.

**The MCP server, not the subagent, is the load-bearing layer.** The subagent is a situational
context optimizer.

---

## 9. Risks & mitigations

| Risk | Severity | Mitigation |
|------|:--------:|------------|
| **ToS** — reusing Claude token outside first-party binary; multi-tenant on one seat | 🔴 High | Only spawn the real `claude -p`; single-user + local; never export the OAuth token |
| Automated delegation **exhausts interactive quota** (shared 5h/weekly windows) | 🟠 Med | Quota ledger + `--max-budget-usd` + backoff + route to backend with headroom |
| **Long tasks time out** the MCP call | 🟠 Med | Async job pattern (core to the design) |
| **Headless auth breaks** (browser popup; macOS Keychain locked for detached procs) | 🟠 Med | Pre-provision: `claude setup-token`→`CLAUDE_CODE_OAUTH_TOKEN`; `codex login --device-auth`; env-inject keys for daemons |
| Delegated code is **wrong/subtly bad** | 🟠 Med | Mandatory Claude validation + tests before merge; worktree isolation makes rejection cheap |
| Antigravity **JSON unstable**; Gemini JSON aborts on non-fatal errors | 🟡 Low | Best-effort tier; validate output, handle non-zero exits; keep Codex/Claude as anchors |
| Router complexity creep | 🟡 Low | Start rule-based `policy.yaml`; add LLM-router only if measured need |

---

## 10. v1 — tailored build (Codex · TypeScript · local)

**Decisions locked (2026-07-17):** delegate worker = **OpenAI Codex (`codex exec`, ChatGPT plan)**;
deployment = **single-user, local only**; language = **TypeScript**. Claude is the sole brain
(no second `claude -p` worker yet; no API tier yet).

### Scoped component set

| Component | v1 scope |
|-----------|----------|
| Tool surface | `delegate_task(objective, files, context, acceptance, hints)` → `job_id`; `check_delegations()`; `get_delegation_result(job_id)` → summary + diff |
| Router | Single tier (`→ codex`) behind a `policy.yaml` seam — no routing logic yet, but the interface exists so engine #2 is config, not surgery |
| Adapter | Just `CodexAdapter` implementing `execute(task) → {diff, summary, tests, exitCode}` |
| Isolation | `git worktree add` per job |
| Distiller | Full NDJSON/log → disk; return only summary + diff path (context firewall) |
| Quota ledger | Lightweight: track Codex 5h/weekly usage so delegation doesn't starve interactive Codex |

### Codex adapter specifics

- `codex exec --json` → parse **NDJSON events from stdout**, progress from **stderr** (capture separately).
- Codex **refuses to run outside a git repo** → the worktree satisfies this; else `--skip-git-repo-check`.
- For unattended edits set an explicit sandbox: `--sandbox workspace-write` (not the read-only default).
- `-o FILE` / `--output-schema FILE` give a clean final-message + schema-constrained result.
- Auth via `~/.codex/auth.json` (auto-refresh). Its 5h+weekly window is **shared** with interactive
  Codex → keep the quota ledger + backoff.

### "Claude doesn't know it's Codex"

Trivially true in v1, but keep it that way in the tool's return payload (report *"delegated
worker"*, not *"Codex"*) — that's what lets Phase 2 add engines with zero prompt changes.

### Definition of done — Phase 0 spike (½ day)

Claude calls `delegate_task` for a small, well-specified change → Codex implements it in a worktree
→ Claude reviews the returned diff, runs tests, and merges — end to end, once, **synchronously** —
before investing in the async queue and ledger.

---

## 11. Phased roadmap

- **Phase 0 — Spike (½ day):** hard-code one adapter (`codex exec` in a worktree), synchronous, no
  router. Prove the round-trip: Claude → tool → diff → validate → merge.
- **Phase 1 — MVP:** async job queue + `CodexAdapter` + `policy.yaml` single-tier router + distiller
  + worktree isolation + quota ledger.
- **Phase 2:** add a second `claude -p` worker and/or Antigravity; add LiteLLM API-fallback tier;
  circuit-breaker fallback chains; `delegation-manager` subagent for batch fan-out.
- **Phase 3:** escalation loops, optional LLM-based routing, richer merge/conflict handling.

---

## 12. Sources

**Claude Code / Agent SDK**
- [Subagents (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/subagents.md)
- [MCP reference](https://code.claude.com/docs/en/mcp.md)
- [Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Headless mode](https://code.claude.com/docs/en/headless.md)
- [Custom tools (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/custom-tools.md)
- [Permissions (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/permissions.md)
- [Legal & compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Authentication](https://code.claude.com/docs/en/authentication)

**Engines**
- Codex: [exec.md](https://github.com/openai/codex/blob/main/docs/exec.md) · [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) · [auth](https://learn.chatgpt.com/docs/auth) · [pricing](https://developers.openai.com/codex/pricing)
- Antigravity CLI: [Google docs](https://antigravity.google/docs/cli-using) · [headless in CI](https://antigravitylab.net/en/articles/integrations/antigravity-cli-agy-headless-non-tty-stdout-ci)
- Gemini CLI deprecation: [Google blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- OpenCode: [CLI](https://opencode.ai/docs/cli/) · [server](https://opencode.ai/docs/server/) · [providers](https://opencode.ai/docs/providers/)

**Prior art**
- [PAL MCP (zen-mcp-server)](https://github.com/BeehiveInnovations/pal-mcp-server) · [clink doc](https://github.com/BeehiveInnovations/pal-mcp-server/blob/main/docs/tools/clink.md)
- [claude-code-router](https://github.com/musistudio/claude-code-router)
- [LiteLLM](https://github.com/BerriAI/litellm) · [fallbacks](https://docs.litellm.ai/docs/proxy/reliability)
- [codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) · [gemini-mcp-tool](https://github.com/jamubc/gemini-mcp-tool)
- [claude-squad](https://github.com/smtg-ai/claude-squad) · [container-use](https://github.com/dagger/container-use) · [dmux](https://github.com/standardagents/dmux) · [uzi](https://github.com/devflowinc/uzi)

**MCP timeout / async pattern**
- [MCP_TOOL_TIMEOUT issue #47076](https://github.com/anthropics/claude-code/issues/47076) · [async handleId pattern](https://dev.to/aws/fix-mcp-timeouts-async-handleid-pattern-8ek)
- Anthropic third-party access clarification: [The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)
