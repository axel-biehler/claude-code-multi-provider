---
name: delegate
description: Delegate a bounded implementation/test/refactor subtask to an isolated background worker instead of writing it inline, then review and merge its diff. Use PROACTIVELY when a well-specified subtask appears while you keep architecture, review and merge — or when the user runs /delegate. Covers submit→poll→verify→merge and reject→re-delegate/escalate, and where to configure the provider + model. Provider-neutral by design: never name or pick the engine.
---

# Delegate

Route a bounded implementation subtask to a background worker (it runs in an isolated git
worktree), then review and merge its diff. You stay the orchestrator — plan, decompose,
validate, merge. The worker writes code; you own everything else.

This is provider-neutral: which engine runs is the router's business, set in `policy.yaml`.
Never name, guess, or pick the engine in what you say or do — treat every result as coming
from "the delegated worker."

## When to delegate (vs do it inline)

- **Delegate** a well-specified, bounded change — a function + its tests, a typed
  refactor, a scoped bugfix — anything you can state as *objective + files + acceptance
  criteria*.
- **Keep inline** architecture, cross-cutting reasoning, trivial one-liners, and the final
  review/merge. Never delegate the validation itself.

## Choose the effort tier — always

Always set `effort` after assessing the task:

- `light` — mechanical, single-file, fully specified change (rename, small util + its test,
  config tweak)
- `standard` — typical bounded implementation: a function/module + its tests, a scoped bugfix
- `heavy` — cross-cutting or algorithmically tricky work, an ambiguous spec needing judgment,
  or a revision after a rejected attempt

The engine-neutral tier selects the worker's model AND reasoning tier as configured in
`policy.yaml`. On a revision with `parent_job_id`, omitting `effort` auto-escalates one tier
above the parent attempt (`light` → `standard` → `heavy`; no recorded parent effort →
`heavy`); an explicit `effort` always wins.

## The loop

1. **Submit** — `delegate_task({ objective, files?, context?, acceptance?, effort })` returns a
   `job_id` instantly. Make `acceptance` *verifiable* — those criteria are how you'll
   judge the diff. Put the conventions the worker needs in `context`.
2. **Poll** — `check_delegations()` for status (`queued`/`running`/`succeeded`/`failed`).
   Do other work between polls; don't block.
3. **Fetch** — `get_delegation_result({ job_id })` → distilled summary + diff (a large
   diff lands at its `diffPath`).
4. **Verify before merge — mandatory.** In the job's worktree
   (`.delegate/worktrees/<jobId>`) re-run the project's own checks yourself
   (`npx tsc --noEmit`, `npx vitest run`, the build…). **Never trust the worker's own
   "tests passed" claim** — read the diff against every acceptance criterion.
5. **Accept or reject.**
   - *Accept* → commit in the worktree → `git rebase main` → `git merge --ff-only` →
     remove the worktree + delete the branch.
   - *Reject* → re-delegate: `delegate_task({ parent_job_id, feedback, escalate? })`. The
     revision re-applies the parent's diff, carries your `feedback`, and `escalate: true`
     routes to a *different* provider than the one that produced the parent attempt.

## Batches

Two or more subtasks at once, or a long review↔re-delegate loop? Hand the batch to the
**`delegation-manager`** subagent — it owns the fan-out/poll/validate churn in its own
context and returns one consolidated report. You still perform the merges.

## Configure the provider & model

Set in **`policy.yaml`** (copy `policy.example.yaml`; it's local + gitignored):

- `chain:` — the ordered provider fallback: `[codex]`, `[claude]`, `[antigravity]`, `[kimi]`,
  `[mammouth]`, or any ordered combination. The first entry receives every job; later entries are automatic
  fallbacks used only when an earlier provider hits a quota/auth wall. Set this to whatever
  you've authenticated.
- `workers.<provider>.model:` — the model per provider (a codex model id, or a Claude
  alias like `sonnet`), plus per-provider budgets/timeouts.
- `workers.<provider>.models:` — optional per-effort tiers (`light`/`standard`/`heavy`).
  `delegate_task`'s engine-neutral `effort` hint picks the tier; an unset tier falls back to
  `model`. No tiers (or no `effort`) keeps the single `model`. `configure_delegation` writes
  either form.
- `workers.<provider>.reasoning:` — optional scalar or per-effort map. Use engine-native
  values: codex `minimal`/`low`/`medium`/`high`/`xhigh` (`-c model_reasoning_effort`),
  claude `low`/`medium`/`high`/`xhigh`/`max` (`--effort`), antigravity
  `low`/`medium`/`high` (`--effort`), or mammouth `minimal`/`low`/`medium`/`high`/`max`
  (`--variant`); kimi has no reasoning flag — its effort tiers use the per-effort `models`
  map only. If absent, the provider default applies and no flag is passed.

Run `/delegate-init` (or `configure_delegation({ action: "detect" })`) to see which
providers are available and pick the chain, models, and reasoning tiers; `npm run preflight`
exists only inside a clone of the `claude-code-multi-provider` repository, not in the project
being configured.

## Guardrails

- **Merge is always manual** — the worker leaves changes uncommitted in its worktree; the
  accept/merge decision is yours.
- Jobs are **session-scoped**: a server restart forgets in-flight jobs (the quota ledger
  persists). `check_delegations()` reports the server's boot rev/time.
- Keep architecture, review, and merge with yourself — the worker implements, it does not
  review its own work.
