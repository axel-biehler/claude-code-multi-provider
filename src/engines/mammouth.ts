import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

export interface RunMammouthOptions {
  readonly mammouthBin?: string
  readonly worktreePath: string
  readonly prompt: string
  readonly paths: JobPaths
  readonly model?: string
  readonly reasoning?: string
  readonly timeoutMs?: number
}

// `extends` is the compile-time proof this stays assignable to the engine-neutral WorkerOutcome.
export interface RunMammouthResult extends WorkerOutcome {
  readonly exitCode: number
  readonly lastMessage: string | null
  readonly durationMs: number
  readonly failureKind?: FailureKind
  readonly retryAtMs?: number
}

export function parseMammouthEvents(raw: string): {
  readonly lastMessage: string | null
  readonly errorMessage: string | null
} {
  let lastMessage: string | null = null
  let errorMessage: string | null = null

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue

    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue

      const event = parsed as {
        type?: unknown
        part?: unknown
        error?: unknown
      }
      if (event.type === 'text' && typeof event.part === 'object' && event.part !== null) {
        const part = event.part as { text?: unknown }
        if (typeof part.text === 'string') lastMessage = part.text
      }
      if (event.type === 'error') {
        errorMessage = null
        if (typeof event.error !== 'object' || event.error === null) continue
        const error = event.error as { name?: unknown; data?: unknown }
        if (typeof error.data === 'object' && error.data !== null) {
          const data = error.data as { message?: unknown }
          if (typeof data.message === 'string') {
            errorMessage = data.message
            continue
          }
        }
        if (typeof error.name === 'string') errorMessage = error.name
      }
    } catch {
      // Mammouth may interleave non-JSON diagnostics with its NDJSON events.
    }
  }

  return { lastMessage, errorMessage }
}

export function classifyMammouthFailure(input: {
  readonly exitCode: number
  readonly eventsText: string
  readonly stderrText: string
}): FailureKind | undefined {
  if (input.exitCode === 0) return undefined
  return classifyFailureText(`${input.eventsText}\n${input.stderrText}`)
}

export function buildMammouthArgs(options: RunMammouthOptions): string[] {
  return [
    'run',
    '--format',
    'json',
    '--dangerously-skip-permissions',
    ...(options.model === undefined ? [] : [`--model=${options.model}`]),
    ...(options.reasoning === undefined ? [] : [`--variant=${options.reasoning}`]),
    // The separator prevents a prompt beginning with "-" from being parsed as a flag.
    '--',
    options.prompt,
  ]
}

export async function resolveMammouthBin(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const localPath = join(
    home,
    '.mammouth',
    'bin',
    platform === 'win32' ? 'mammouth.exe' : 'mammouth',
  )
  try {
    await access(localPath)
    return localPath
  } catch {
    return 'mammouth'
  }
}

export function runMammouth(options: RunMammouthOptions): Promise<RunMammouthResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RunMammouthResult>((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(options.mammouthBin ?? 'mammouth', buildMammouthArgs(options), {
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
          const failureKind = classifyMammouthFailure({
            exitCode,
            eventsText: raw,
            stderrText,
          })
          const text = `${raw}\n${stderrText}`
          const retryAtMs = failureKind === 'quota' ? parseRetryAt(text, Date.now()) : undefined
          const parsed = parseMammouthEvents(raw)
          resolve({
            exitCode,
            lastMessage: parsed.lastMessage ?? parsed.errorMessage,
            durationMs: performance.now() - startedAt,
            failureKind,
            ...(retryAtMs === undefined ? {} : { retryAtMs }),
          })
        })
    })
  })
}
