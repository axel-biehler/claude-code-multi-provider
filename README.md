# claude-code-multi-provider

A **delegate MCP server** for Claude Code. Claude Code stays the orchestrator — it
plans, decomposes, and validates — and hands bounded implementation subtasks to
subscription-CLI workers (Codex, Claude, and Antigravity) running in isolated git
worktrees. The four-tool surface hides which engine ran: you get back a distilled
summary and a diff to review and merge.

```
Claude Code ──delegate_task──▶ router (policy.yaml) ──▶ worker (codex / claude / antigravity)
     ▲                                                     │  isolated git worktree
     └──────── summary + diff ◀── check_delegations ◀──────┘  full logs to .delegate/
```

## Quickstart

```bash
git clone git@github.com:axel-biehler/claude-code-multi-provider.git
cd claude-code-multi-provider
npm run setup            # node check → deps → policy.yaml → static preflight
npm run codex-login      # authenticate the bundled Codex worker (once)
npm run preflight        # live probe: confirms the engine actually answers
```

Then open the repo in **Claude Code**. The `delegate` server is auto-registered via
[.mcp.json](.mcp.json) — confirm with `/mcp`, then call `delegate_task`.

`npm run setup` is idempotent; re-run it any time. On a TTY it runs the interactive
`npm run configure` flow — provider order, then a model per provider picked from
suggested ids (free-form ids stay valid), then optional per-effort tiers; in automation
it keeps the copy-only setup behavior. The script is plain Node: it behaves the same
from macOS/Linux shells and Windows PowerShell/cmd.

## Install as a Claude Code plugin

To use delegation in *any* project — not just this repo — install it as a plugin:

```bash
claude plugin marketplace add axel-biehler/claude-code-multi-provider
claude plugin install delegate-multi-provider@claude-code-multi-provider
```

The plugin bundles the MCP server (one self-contained file), the `delegate` and
`delegate-init` skills, and the `delegation-manager` subagent. It operates on whatever
project you have open (`$CLAUDE_PROJECT_DIR`) — worktrees, `policy.yaml`, and `.delegate/`
all live in that repo. Run `/delegate-init` to detect the available providers, choose their
order and models — it proposes suggested models per provider and optional per-effort
tiers — and write `policy.yaml` through the bundled tool. Without a policy it uses
the defaults.

The worker CLIs are **not** bundled (they're heavy/native), so a plugin user still needs:

- **Node.js ≥ 20**
- **Codex on PATH** for the Codex worker: `npm i -g @openai/codex && codex login`
- *(optional)* a Claude seat for the fallback (`claude setup-token`)
- *(optional)* Antigravity `agy` on PATH for the Antigravity worker

*(Maintainer: rebuild the bundle after touching `src/`, a skill, or the subagent with
`npm run build:plugin`, then commit `plugin/`.)*

## Prerequisites

- **Node.js ≥ 20**
- **A ChatGPT/Codex subscription** for the Codex worker. Codex ships as a bundled
  dependency — no global install — so authenticate via `npm run codex-login`.
  (Don't run `npx codex`: it resolves an unrelated registry package, not the bundled CLI.)
- *(optional)* **A Claude seat** for the fallback worker — `claude setup-token`. The
  chain works on Codex alone; Claude and Antigravity tiers only engage when configured.
- *(optional)* **Antigravity `agy`** for the third worker; it is opt-in through `policy.yaml`.

## Platform support

- **macOS** — primary target; worktree deps are APFS copy-on-write clones.
- **Linux** — supported; worktree deps clone via reflink on btrfs/XFS and fall back to a
  symlink elsewhere.
- **Windows** — `npm run setup`, `npm run configure`, and the bundled Codex worker are
  built to run natively (PowerShell/cmd): everything is plain Node, the codex CLI is
  invoked through Node directly (no `.cmd` shim), the worker env allow-list passes the
  required Windows variables, worktree deps fall back to a directory junction (no admin
  rights needed), and the timeout guard tree-kills the worker so a native codex child
  isn't orphaned. The Claude worker needs the native `claude` installer (`claude.exe` on
  PATH). Native Windows isn't CI-verified yet — treat it as best-effort; WSL2 remains the
  most-tested route.

## Using it

The bundled **`delegate` skill** encodes the workflow below — auto-invoked when a bounded
subtask appears, or call `/delegate`. It ships in the repo, so anyone who clones and opens
it in Claude Code gets it.

Plugin users can call **`/delegate-init`** to detect available providers and configure the
routing chain and models. The skill writes `policy.yaml` through `configure_delegation`,
preserving unrelated policy fields.

`delegate_task` returns a `job_id` immediately and runs the worker in the background:

1. `delegate_task({ objective, files?, context?, acceptance? })` → `{ job_id, status }`
2. `check_delegations()` → server info + every job's status (`queued`/`running`/`succeeded`/`failed`)
3. `get_delegation_result({ job_id })` → distilled summary + diff once finished

To revise a rejected attempt, pass `parent_job_id` (+ optional `feedback`, and
`escalate: true` to route away from the engine that produced it).

**Merging is manual by design** — the orchestrator reviews the diff, then merges the
worktree (`.delegate/worktrees/<jobId>`, branch `delegate/<jobId>`). For batch fan-out
with an iterative review loop, use the `delegation-manager` subagent.

## Choosing your provider & model

Delegation is provider-neutral — the tools never expose which engine ran. From a clone,
run `npm run configure` to detect available providers and interactively choose their order
and models: it proposes suggested model ids per provider (any other id stays valid) and can
set optional per-effort tiers. Its merge-safe writer updates those selections in
`policy.yaml` without dropping other fields. You can also edit the local, gitignored file
by hand (copy `policy.example.yaml` to start):

- `chain:` — ordered provider fallback: `[codex]`, `[claude]`, `[antigravity]`, or
  `[codex, claude, antigravity]`. Set it
  to whatever you've authenticated; `npm run preflight` reports what's usable on your machine.
- `workers.<provider>.model:` — the model per provider (a codex model id, a Claude alias
  like `sonnet`, or an Antigravity model id), plus per-provider budgets and timeouts.
- `workers.<provider>.models.{light,standard,heavy}:` — optional per-effort tiers;
  `delegate_task`'s engine-neutral `effort` hint picks the tier at job time, and an unset
  tier falls back to `model`.

Quotas and artifact retention live in the same file. Every field is optional; an absent
file means the defaults documented in [policy.example.yaml](policy.example.yaml).

## Commands

```bash
npm run preflight                          # env gate + live quota/token probe per engine
npm run preflight -- --no-probe            # static checks only (no requests, no spend)
npm run e2e -- --list-only                 # smoke: server boots + lists the 4 tools
npm run e2e -- examples/example-task.json  # full async round-trip
npm run gc -- --dry-run                    # preview worktree/job cleanup
npm test                                   # unit + integration suite
npm run typecheck                          # tsc --noEmit
```

## Layout

`src/server.ts` is a thin boot entry; the tool surface lives in `src/mcp/`, with domains
under `src/{jobs,routing,engines,git}/`. See [CLAUDE.md](CLAUDE.md) for conventions and
[docs/](docs/) for the architecture and phase results.

## Scope & ToS

Personal, **single-user, local** by design: the workers spawn the genuine first-party
CLIs on *your own* seat (ordinary use). Do not lift subscription tokens into third-party
clients or fan multiple users through one seat. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4.

## License

[MIT](LICENSE) © Axel Biehler
