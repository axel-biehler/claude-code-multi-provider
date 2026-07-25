import { execFile } from 'node:child_process'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { runAntigravity } from '../engines/antigravity'
import { runClaude } from '../engines/claude'
import { resolveCodexConfigOverrides, runCodex } from '../engines/codex'
import { runKimi } from '../engines/kimi'
import { resolveCodexCli, resolveKimiBin } from '../engines/shared/cli-command'
import type { CliCommand } from '../engines/shared/cli-command'
import { buildPrompt } from '../engines/shared/prompt'
import { collectDiff, createWorktree, removeWorktree } from '../git/worktree'
import type { Policy } from '../routing/policy'
import type { QuotaLedger } from '../routing/quota'
import { resolveWorkerModel, resolveWorkerReasoning, selectEngine } from '../routing/router'
import type {
  DelegateResult,
  DelegateTask,
  Effort,
  EngineName,
  JobPaths,
  WorkerOutcome,
  WorktreeInfo,
} from '../types'
import { buildJobPaths } from './paths'

const execFileAsync = promisify(execFile)

const SUMMARY_MAX_CHARS = 1500
const ALL_ENGINES_AT_CAPACITY_MESSAGE =
  'All delegation engines are at capacity — retry after quota cooldown.'
const ESCALATION_IMPOSSIBLE_MESSAGE =
  'Escalation impossible: no alternative engine available. Re-delegate without escalate to allow the same engine.'
const PARENT_DIFF_CONFLICT_MESSAGE =
  'Parent diff no longer applies onto the current base (the main branch advanced since the parent job). Re-delegate without parent_job_id for a fresh attempt.'

export interface RevisionSpec {
  readonly parentDiffPath: string
  readonly feedback?: string
  readonly excludeEngine?: EngineName
  readonly parentEffort?: Effort
}

export interface WorkerRunRequest {
  readonly engine: EngineName
  readonly model?: string
  readonly reasoning?: string
  readonly repoRoot: string
  readonly worktreePath: string
  readonly prompt: string
  readonly paths: JobPaths
  readonly policy: Policy
}

export type WorkerRunner = (req: WorkerRunRequest) => Promise<WorkerOutcome>

export interface ExecutorDeps {
  readonly repoRoot: string
  readonly policy: Policy
  readonly ledger: QuotaLedger
  readonly runWorker?: WorkerRunner
}

export function escalateEffortTier(parent?: Effort): Effort {
  if (parent === 'light') return 'standard'
  return 'heavy'
}

// Copy-on-write clone command per platform; null = no clone tool, go straight to the
// symlink fallback. APFS clonefile on macOS; reflink on Linux (btrfs/XFS — ext4 fails
// fast and falls back). Windows has no `cp` at all.
export function cloneCommandFor(
  platform: NodeJS.Platform,
  source: string,
  target: string,
): CliCommand | null {
  if (platform === 'darwin') return { command: 'cp', args: ['-c', '-R', source, target] }
  if (platform === 'linux') {
    return { command: 'cp', args: ['-R', '--reflink=always', source, target] }
  }
  return null
}

// Best-effort only: lets the worker run tests/tooling that expect installed deps.
// Clone-first (near-instant, copy-on-write) closes limitation M2 — through the old
// symlink a workspace-write worker could edit SHARED deps with nothing in the diff —
// and the last live run showed codex's sandbox treats the symlink target as read-only,
// forcing workarounds when a tool writes inside node_modules. Symlink stays as the
// no-clone fallback ('junction' so Windows needs no admin rights; the type is ignored
// on POSIX); absence of deps never fails the job.
async function provisionNodeModules(repoRoot: string, worktreePath: string): Promise<void> {
  const source = join(repoRoot, 'node_modules')
  const target = join(worktreePath, 'node_modules')
  const clone = cloneCommandFor(process.platform, source, target)
  if (clone !== null) {
    try {
      await execFileAsync(clone.command, [...clone.args])
      console.error('[delegate] job deps: cloned')
      return
    } catch {
      // Non-CoW volume or no node_modules at all — fall through to the legacy symlink.
    }
  }
  try {
    await symlink(source, target, 'junction')
    console.error('[delegate] job deps: symlinked')
  } catch {
    console.error('[delegate] job deps: absent')
  }
}

async function resolveAntigravityBin(): Promise<string> {
  const localPath = join(homedir(), '.local', 'bin', 'agy')
  try {
    await access(localPath)
    return localPath
  } catch {
    return 'agy'
  }
}

function truncateSummary(lastMessage: string | null): string {
  const raw = lastMessage ?? '(worker returned no message)'
  return raw.length > SUMMARY_MAX_CHARS ? `${raw.slice(0, SUMMARY_MAX_CHARS)}…` : raw
}

// Concurrent `git worktree add`/`remove` + `branch -D` in one repo contend on shared
// git administrative state, so every worktree-mutating git call is serialized here;
// the workers themselves still run in parallel.
let worktreeGitLock: Promise<unknown> = Promise.resolve()

function withWorktreeGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const acquired = worktreeGitLock.then(fn)
  worktreeGitLock = acquired.then(
    () => undefined,
    () => undefined,
  )
  return acquired
}

async function cleanupWorktree(
  repoRoot: string,
  worktree: WorktreeInfo | undefined,
): Promise<void> {
  if (!worktree) return
  try {
    // Failed attempts leave no debris: drop the branch along with the worktree.
    await withWorktreeGitLock(() =>
      removeWorktree(repoRoot, worktree.path, worktree.branch, { deleteBranch: true }),
    )
  } catch (error) {
    // Best-effort — don't let a cleanup failure mask the original error, but leave an
    // operator breadcrumb so an orphaned worktree/branch isn't silently invisible.
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[delegate] worktree cleanup failed for ${worktree.path}: ${detail}`)
  }
}

function createWorktreeSerialized(repoRoot: string, jobId: string): Promise<WorktreeInfo> {
  return withWorktreeGitLock(() => createWorktree(repoRoot, jobId))
}

// Adapter-level rejections (e.g. a spawn ENOENT) name the engine binary; the caller-visible
// error must stay engine-neutral, so the detail goes to stderr and a neutral error rethrows.
export function neutralizeRunnerErrors(runner: WorkerRunner): WorkerRunner {
  return async (req: WorkerRunRequest): Promise<WorkerOutcome> => {
    try {
      return await runner(req)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[delegate] worker process error (${req.engine}): ${detail}`)
      throw new Error('Delegated worker process failed to start or crashed before producing a result.')
    }
  }
}

export function buildDefaultWorkerRunner(): WorkerRunner {
  return neutralizeRunnerErrors(async (req: WorkerRunRequest): Promise<WorkerOutcome> => {
    if (req.engine === 'claude') {
      const worker = req.policy.workers.claude
      return runClaude({
        worktreePath: req.worktreePath,
        prompt: req.prompt,
        paths: req.paths,
        timeoutMs: worker.timeoutMs,
        model: req.model,
        reasoning: req.reasoning,
        maxBudgetUsd: worker.maxBudgetUsd,
      })
    }
    if (req.engine === 'antigravity') {
      const worker = req.policy.workers.antigravity
      return runAntigravity({
        agyBin: await resolveAntigravityBin(),
        worktreePath: req.worktreePath,
        prompt: req.prompt,
        paths: req.paths,
        timeoutMs: worker.timeoutMs,
        model: req.model,
        reasoning: req.reasoning,
      })
    }
    if (req.engine === 'kimi') {
      return runKimi({
        kimiBin: await resolveKimiBin(),
        worktreePath: req.worktreePath,
        prompt: req.prompt,
        paths: req.paths,
        timeoutMs: req.policy.workers.kimi.timeoutMs,
        model: req.model,
      })
    }
    const codexCli = await resolveCodexCli(req.repoRoot)
    const configOverrides = await resolveCodexConfigOverrides(codexCli)
    const worker = req.policy.workers.codex
    return runCodex({
      codexCli,
      configOverrides,
      worktreePath: req.worktreePath,
      prompt: req.prompt,
      paths: req.paths,
      timeoutMs: worker.timeoutMs,
      model: req.model,
      reasoning: req.reasoning,
    })
  })
}

interface EngineAttempt {
  readonly engine: EngineName
  readonly worktree: WorktreeInfo
  readonly outcome: WorkerOutcome
}

type RoutingSignalOutcome = WorkerOutcome & { readonly failureKind: 'quota' | 'auth' }

function isRoutingSignal(outcome: WorkerOutcome): outcome is RoutingSignalOutcome {
  return outcome.failureKind === 'quota' || outcome.failureKind === 'auth'
}

/**
 * Walks the policy chain until a worker actually runs (success OR plain failure).
 * quota/auth outcomes are routing signals, not job failures: the engine is cooled
 * down on the ledger and the next selectEngine call naturally skips it.
 */
async function runEngineChain(
  deps: ExecutorDeps,
  runWorker: WorkerRunner,
  jobId: string,
  prompt: string,
  paths: JobPaths,
  revision?: RevisionSpec,
  effort?: Effort,
): Promise<EngineAttempt> {
  let worktree: WorktreeInfo | undefined
  try {
    for (let attempt = 0; attempt < deps.policy.chain.length; attempt += 1) {
      const engine = selectEngine(deps.policy, deps.ledger, revision?.excludeEngine)
      if (engine === null) break
      const model = resolveWorkerModel(deps.policy, engine, effort)
      const reasoning = resolveWorkerReasoning(deps.policy, engine, effort)

      worktree = await createWorktreeSerialized(deps.repoRoot, jobId)
      await provisionNodeModules(deps.repoRoot, worktree.path)
      if (revision !== undefined) {
        const parentDiff = await readFile(revision.parentDiffPath, 'utf8')
        if (parentDiff.trim().length > 0) {
          try {
            await execFileAsync(
              'git',
              ['apply', '--whitespace=nowarn', revision.parentDiffPath],
              { cwd: worktree.path },
            )
          } catch {
            throw new Error(PARENT_DIFF_CONFLICT_MESSAGE)
          }
        }
      }

      const outcome = await runWorker({
        engine,
        model,
        reasoning,
        repoRoot: deps.repoRoot,
        worktreePath: worktree.path,
        prompt,
        paths,
        policy: deps.policy,
      })

      if (!isRoutingSignal(outcome)) {
        return { engine, worktree, outcome }
      }

      await deps.ledger.record({
        engine,
        durationMs: outcome.durationMs,
        outcome: outcome.failureKind,
      })
      if (outcome.retryAtMs !== undefined) {
        await deps.ledger.markExhaustedUntil(engine, outcome.retryAtMs)
      } else {
        await deps.ledger.markExhausted(
          engine,
          deps.policy.quotas[engine].exhaustionCooldownMinutes,
        )
      }
      await cleanupWorktree(deps.repoRoot, worktree)
      worktree = undefined
      const cooldownDetail =
        outcome.retryAtMs === undefined
          ? ''
          : `; cooldown until ${new Date(outcome.retryAtMs).toISOString()}`
      console.error(
        `[delegate] job ${jobId} worker unavailable (${outcome.failureKind}${cooldownDetail}) — rerouting`,
      )
    }
    throw new Error(
      revision?.excludeEngine === undefined
        ? ALL_ENGINES_AT_CAPACITY_MESSAGE
        : ESCALATION_IMPOSSIBLE_MESSAGE,
    )
  } catch (error) {
    await cleanupWorktree(deps.repoRoot, worktree)
    throw error
  }
}

/**
 * Full delegation pipeline for one job: prompt → engine chain → worker → diff.
 * A non-zero worker exit is NOT a throw — the result carries the exitCode and the
 * worktree is kept for inspection (Phase-0 semantics). Only infra errors reject.
 */
export async function executeJob(
  deps: ExecutorDeps,
  jobId: string,
  task: DelegateTask,
  revision?: RevisionSpec,
): Promise<DelegateResult> {
  const startedAt = performance.now()
  const runWorker = deps.runWorker ?? buildDefaultWorkerRunner()
  const paths = buildJobPaths(deps.repoRoot, jobId)

  await mkdir(paths.jobDir, { recursive: true })
  const prompt = buildPrompt(task, revision)
  await writeFile(paths.promptFile, prompt, 'utf8')

  // A rejected attempt signals that its selected tier was too low.
  const effort =
    task.effort ??
    (revision === undefined ? undefined : escalateEffortTier(revision.parentEffort))
  const { engine, worktree, outcome } = await runEngineChain(
    deps,
    runWorker,
    jobId,
    prompt,
    paths,
    revision,
    effort,
  )

  // The engine consumed real quota the moment the worker ran, whether or not
  // the post-processing below succeeds.
  await deps.ledger.record({
    engine,
    durationMs: outcome.durationMs,
    outcome: outcome.exitCode === 0 ? 'ok' : 'other',
  })

  try {
    const diff = await collectDiff(worktree.path)
    await writeFile(paths.diffFile, diff, 'utf8')

    return {
      jobId,
      branch: worktree.branch,
      worktreePath: worktree.path,
      summary: truncateSummary(outcome.lastMessage),
      diffPath: paths.diffFile,
      diff,
      exitCode: outcome.exitCode,
      durationMs: performance.now() - startedAt,
      engine,
    }
  } catch (error) {
    // The worker's edits exist on disk — never destroy them over a bookkeeping failure.
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[delegate] job ${jobId} result collection failed (worktree preserved): ${detail}`)
    throw new Error(
      `Worker finished but result collection failed: ${detail}. ` +
        `Worktree preserved at ${worktree.path} (branch ${worktree.branch}).`,
    )
  }
}
