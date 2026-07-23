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

export interface RunAntigravityOptions {
  readonly agyBin?: string
  readonly worktreePath: string
  readonly prompt: string
  readonly paths: JobPaths
  readonly model?: string
  readonly reasoning?: string
  readonly timeoutMs?: number
}

// `extends` is the compile-time proof this stays assignable to the engine-neutral WorkerOutcome.
export interface RunAntigravityResult extends WorkerOutcome {
  readonly exitCode: number
  readonly lastMessage: string | null
  readonly durationMs: number
  readonly failureKind?: FailureKind
  readonly retryAtMs?: number
}

export function parseAntigravityJson(raw: string): {
  readonly lastMessage: string | null
  readonly status: string | null
} {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { lastMessage: null, status: null }
    }
    const result = parsed as { response?: unknown; status?: unknown }
    return {
      lastMessage: typeof result.response === 'string' ? result.response.trim() : null,
      status: typeof result.status === 'string' ? result.status : null,
    }
  } catch {
    return { lastMessage: null, status: null }
  }
}

export function classifyAntigravityFailure(input: {
  readonly exitCode: number
  readonly resultJson: string
  readonly stderrText: string
}): FailureKind | undefined {
  if (input.exitCode === 0) return undefined
  return classifyFailureText(`${input.resultJson}\n${input.stderrText}`)
}

export function buildAntigravityArgs(options: RunAntigravityOptions): string[] {
  return [
    '-p',
    options.prompt,
    // agy resolves its workspace from --add-dir, NOT cwd: with an empty workspace a
    // headless `-p` run writes into agy's own scratch dir (or a stale registered
    // workspace), escaping the worktree and leaving collectDiff empty. Pinning the
    // worktree here is what keeps the worker's edits inside the sandbox + in the diff.
    '--add-dir',
    options.worktreePath,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--print-timeout',
    `${Math.ceil((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1_000)}s`,
    ...(options.model === undefined ? [] : [`--model=${options.model}`]),
    ...(options.reasoning === undefined ? [] : [`--effort=${options.reasoning}`]),
  ]
}

export function runAntigravity(
  options: RunAntigravityOptions,
): Promise<RunAntigravityResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RunAntigravityResult>((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(options.agyBin ?? 'agy', buildAntigravityArgs(options), {
      cwd: options.worktreePath,
      env: buildWorkerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

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
          const failureKind = classifyAntigravityFailure({
            exitCode,
            resultJson: raw,
            stderrText,
          })
          const text = `${raw}\n${stderrText}`
          const retryAtMs = failureKind === 'quota' ? parseRetryAt(text, Date.now()) : undefined
          resolve({
            exitCode,
            lastMessage: parseAntigravityJson(raw).lastMessage,
            durationMs: performance.now() - startedAt,
            failureKind,
            ...(retryAtMs === undefined ? {} : { retryAtMs }),
          })
        })
    })
  })
}
