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
const KIMI_AUTH_PATTERN = /no model configured|\/login|sign in/i

export interface RunKimiOptions {
  readonly kimiBin?: string
  readonly worktreePath: string
  readonly prompt: string
  readonly paths: JobPaths
  readonly model?: string
  readonly timeoutMs?: number
}

// `extends` is the compile-time proof this stays assignable to the engine-neutral WorkerOutcome.
export interface RunKimiResult extends WorkerOutcome {
  readonly exitCode: number
  readonly lastMessage: string | null
  readonly durationMs: number
  readonly failureKind?: FailureKind
  readonly retryAtMs?: number
}

function extractTextContent(content: unknown): string | null {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (part): part is { readonly type: 'text'; readonly text: string } =>
                typeof part === 'object' &&
                part !== null &&
                (part as { readonly type?: unknown }).type === 'text' &&
                typeof (part as { readonly text?: unknown }).text === 'string',
            )
            .map((part) => part.text)
            .join('')
        : ''
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function parseKimiStreamJson(raw: string): {
  readonly lastMessage: string | null
} {
  return raw.split(/\r?\n/).reduce<{ readonly lastMessage: string | null }>(
    (result, line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== 'object' || parsed === null) return result
        const message = parsed as { readonly role?: unknown; readonly content?: unknown }
        if (message.role !== 'assistant') return result
        const text = extractTextContent(message.content)
        return text === null ? result : { lastMessage: text }
      } catch {
        return result
      }
    },
    { lastMessage: null },
  )
}

export function classifyKimiFailure(input: {
  readonly exitCode: number
  readonly streamText: string
  readonly stderrText: string
}): FailureKind | undefined {
  if (input.exitCode === 0) return undefined
  const text = `${input.streamText}\n${input.stderrText}`
  const failureKind = classifyFailureText(text)
  if (failureKind !== 'other') return failureKind
  if (KIMI_AUTH_PATTERN.test(text)) return 'auth'
  // Exit 75 is Kimi's documented retryable class, so cooldown + reroute is actionable.
  if (input.exitCode === 75) return 'quota'
  return 'other'
}

export function buildKimiArgs(options: RunKimiOptions): string[] {
  return [
    '-p',
    options.prompt,
    // kimi resolves its workspace from --add-dir, NOT cwd: pinning it here keeps the
    // worker's edits inside the worktree sandbox and visible to collectDiff.
    '--add-dir',
    options.worktreePath,
    '--output-format',
    'stream-json',
    // Prompt mode needs no permission flag; Kimi rejects --yolo and --auto with -p.
    ...(options.model === undefined ? [] : [`--model=${options.model}`]),
  ]
}

export function runKimi(options: RunKimiOptions): Promise<RunKimiResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RunKimiResult>((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(options.kimiBin ?? 'kimi', buildKimiArgs(options), {
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
          const failureKind = classifyKimiFailure({
            exitCode,
            streamText: raw,
            stderrText,
          })
          const text = `${raw}\n${stderrText}`
          const retryAtMs = failureKind === 'quota' ? parseRetryAt(text, Date.now()) : undefined
          resolve({
            exitCode,
            lastMessage: parseKimiStreamJson(raw).lastMessage,
            durationMs: performance.now() - startedAt,
            failureKind,
            ...(retryAtMs === undefined ? {} : { retryAtMs }),
          })
        })
    })
  })
}
