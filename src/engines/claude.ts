import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import type { FailureKind, JobPaths, WorkerOutcome } from '../types'
import { classifyFailureText, parseRetryAt } from './shared/failure-signals'
import {
  armTimeoutGuard,
  drainToFile,
  unmaskTimedOutExit,
} from './shared/worker-process'
import { buildWorkerEnv } from './shared/worker-env'

const DEFAULT_TIMEOUT_MS = 600_000
const WORKER_MODEL = 'sonnet'
const WORKER_BUDGET_USD = '2'

// Finding 6: Phase 0 passed the space form 'Bash(npx vitest *)' — not valid permission-rule
// grammar, so Bash silently stayed gated and the worker hand-traced its tests instead of
// running them. Bash rules take the colon-prefix form: 'Bash(npx vitest:*)'.
// The rtk duplicates exist because the worker inherits the user's ~/.claude PreToolUse hook,
// which rewrites `npx vitest …` → `rtk vitest …` and permissions evaluate the REWRITTEN
// command (observed live: denials on `rtk vitest`). A pristine CLAUDE_CONFIG_DIR was probed
// and rejected — the CLI reports "Not logged in" without the user's config dir.
export const WORKER_ALLOWED_TOOLS =
  'Bash(npx vitest:*),Bash(npx tsc:*),Bash(rtk vitest:*),Bash(rtk tsc:*)'

export interface RunClaudeOptions {
  readonly worktreePath: string
  readonly prompt: string
  readonly paths: JobPaths
  readonly timeoutMs?: number
  readonly claudeBin?: string
  readonly model?: string
  readonly reasoning?: string
  readonly maxBudgetUsd?: number
}

// `extends` is the compile-time proof this stays assignable to the engine-neutral WorkerOutcome.
export interface RunClaudeResult extends WorkerOutcome {
  readonly exitCode: number
  readonly lastMessage: string | null
  readonly durationMs: number
  readonly failureKind?: FailureKind
  readonly retryAtMs?: number
}

const BUDGET_PATTERN = /max budget|budget exceeded|budget limit/i

export function classifyClaudeFailure(input: {
  readonly exitCode: number
  readonly resultJson: string
  readonly stderrText: string
}): FailureKind | undefined {
  if (input.exitCode === 0) return undefined
  const text = `${input.resultJson}\n${input.stderrText}`
  // --max-budget-usd is a per-job guard, not engine exhaustion — checked before the
  // quota patterns so the router never reroutes to another engine over a budget stop.
  if (BUDGET_PATTERN.test(text)) return 'other'
  return classifyFailureText(text)
}

// claude -p --output-format json prints a single JSON object; `result` is the final message.
export function parseClaudeJson(raw: string): { lastMessage: string | null } {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { lastMessage: null }
    const result = (parsed as { result?: unknown }).result
    return { lastMessage: typeof result === 'string' ? result : null }
  } catch {
    return { lastMessage: null }
  }
}

export function runClaude(options: RunClaudeOptions): Promise<RunClaudeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RunClaudeResult>((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(
      options.claudeBin ?? 'claude',
      [
        '-p',
        options.prompt,
        '--output-format',
        'json',
        `--model=${options.model ?? WORKER_MODEL}`,
        ...(options.reasoning === undefined ? [] : [`--effort=${options.reasoning}`]),
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        WORKER_ALLOWED_TOOLS,
        '--max-budget-usd',
        String(options.maxBudgetUsd ?? WORKER_BUDGET_USD),
      ],
      {
        cwd: options.worktreePath,
        env: buildWorkerEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const stdoutDone = drainToFile(child.stdout, options.paths.eventsFile)
    const stderrDone = drainToFile(child.stderr, options.paths.stderrFile)
    const streamsSettled = (): Promise<unknown> => Promise.allSettled([stdoutDone, stderrDone])

    const guard = armTimeoutGuard(child, timeoutMs)

    child.on('error', (error) => {
      guard.disarm()
      void streamsSettled().then(() => reject(error))
    })

    child.on('close', (code) => {
      guard.disarm()
      if (guard.didTimeout()) {
        console.error(
          `[delegate] worker exceeded ${timeoutMs}ms and was terminated — treating exit as failure`,
        )
      }
      void streamsSettled()
        .then(() =>
          Promise.all([
            readFile(options.paths.eventsFile, 'utf8').catch(() => ''),
            readFile(options.paths.stderrFile, 'utf8').catch(() => ''),
          ]),
        )
        .then(([raw, stderrText]) => {
          const exitCode = unmaskTimedOutExit(code ?? -1, guard.didTimeout())
          const failureKind = classifyClaudeFailure({ exitCode, resultJson: raw, stderrText })
          const text = `${raw}\n${stderrText}`
          const retryAtMs = failureKind === 'quota' ? parseRetryAt(text, Date.now()) : undefined
          resolve({
            exitCode,
            lastMessage: parseClaudeJson(raw).lastMessage,
            durationMs: performance.now() - startedAt,
            failureKind,
            ...(retryAtMs === undefined ? {} : { retryAtMs }),
          })
        })
    })
  })
}
