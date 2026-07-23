import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import type { FailureKind, JobPaths, WorkerOutcome } from '../types'
import { cliInvocation } from './shared/cli-command'
import type { CliCommand } from './shared/cli-command'
import { classifyFailureText, parseRetryAt } from './shared/failure-signals'
import { armTimeoutGuard, drainToFile, unmaskTimedOutExit } from './shared/worker-process'
import { buildWorkerEnv } from './shared/worker-env'

const DEFAULT_TIMEOUT_MS = 600_000

interface AgentMessageEvent {
  readonly item: {
    readonly text: string
  }
}

// Codex's NDJSON stream carries many event types; only a completed agent_message matters here.
function isAgentMessageEvent(value: unknown): value is AgentMessageEvent {
  if (typeof value !== 'object' || value === null) return false
  const event = value as { type?: unknown; item?: unknown }
  if (event.type !== 'item.completed') return false
  if (typeof event.item !== 'object' || event.item === null) return false
  const item = event.item as { type?: unknown; text?: unknown }
  return item.type === 'agent_message' && typeof item.text === 'string'
}

export function parseEvents(ndjson: string): { lastMessage: string | null } {
  const lines = ndjson.split(/\r?\n/).filter((line) => line.trim().length > 0)

  const lastMessage = lines.reduce<string | null>((message, line) => {
    try {
      const parsed: unknown = JSON.parse(line)
      return isAgentMessageEvent(parsed) ? parsed.item.text : message
    } catch {
      // Malformed NDJSON lines are skipped rather than failing the whole parse.
      return message
    }
  }, null)

  return { lastMessage }
}

export function classifyCodexFailure(input: {
  readonly exitCode: number
  readonly eventsNdjson: string
  readonly stderrText: string
}): FailureKind | undefined {
  if (input.exitCode === 0) return undefined
  return classifyFailureText(`${input.eventsNdjson}\n${input.stderrText}`)
}

// Keeps the user's personal ~/.codex/config.toml MCP servers out of delegated jobs.
// An isolated CODEX_HOME would too, but auth.json lives there — isolating it orphans
// the subscription auth (copy: token lineages diverge on refresh; symlink: replace-on-write
// breaks it) — so per-invocation overrides are the safe equivalent.
// codex 0.144.x deep-merges `-c mcp_servers={}` into the file config (observed live:
// a no-op — every personal server leaked into jobs, and a dead HTTP entry stalled a
// job's turn start for its whole timeout). Per-server `enabled=false` is the only
// override form that verifiably disables an entry, so enumerate and disable each.
export const CODEX_CONFIG_OVERRIDES: readonly string[] = ['-c', 'mcp_servers={}']

// TOML bare keys allow [A-Za-z0-9_-]; anything else needs a quoted key segment.
function tomlKeySegment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `"${name.replaceAll('"', '\\"')}"`
}

export function buildMcpDisableOverrides(listJson: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(listJson)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is { name: string } => {
        if (typeof entry !== 'object' || entry === null) return false
        const candidate = entry as { name?: unknown; enabled?: unknown }
        return typeof candidate.name === 'string' && candidate.enabled === true
      })
      .flatMap((entry) => ['-c', `mcp_servers.${tomlKeySegment(entry.name)}.enabled=false`])
  } catch {
    return []
  }
}

// `codex mcp list --json` is offline and fast (~100ms); a failure (older CLI, parse
// drift) must never block the job — fall back to the legacy blanket override alone.
export async function resolveCodexConfigOverrides(
  codexCli: CliCommand,
  runList: (cli: CliCommand) => Promise<string> = defaultRunMcpList,
): Promise<readonly string[]> {
  try {
    const listJson = await runList(codexCli)
    return [...CODEX_CONFIG_OVERRIDES, ...buildMcpDisableOverrides(listJson)]
  } catch {
    return CODEX_CONFIG_OVERRIDES
  }
}

async function defaultRunMcpList(codexCli: CliCommand): Promise<string> {
  const { command, args } = cliInvocation(codexCli, ['mcp', 'list', '--json'])
  const { stdout } = await promisify(execFile)(command, args, { timeout: 15_000 })
  return stdout
}

export interface RunCodexOptions {
  readonly codexCli: CliCommand
  readonly worktreePath: string
  readonly prompt: string
  readonly paths: JobPaths
  readonly model?: string
  readonly timeoutMs?: number
  readonly configOverrides?: readonly string[]
}

// `extends` is the compile-time proof this stays assignable to the engine-neutral WorkerOutcome.
export interface RunCodexResult extends WorkerOutcome {
  readonly exitCode: number
  readonly lastMessage: string | null
  readonly durationMs: number
  readonly failureKind?: FailureKind
  readonly retryAtMs?: number
}

export function buildCodexArgs(options: RunCodexOptions): string[] {
  return [
    'exec',
    '--json',
    '--cd',
    options.worktreePath,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--output-last-message',
    options.paths.lastMessageFile,
    ...(options.model === undefined ? [] : [`--model=${options.model}`]),
    ...(options.configOverrides ?? CODEX_CONFIG_OVERRIDES),
    options.prompt,
  ]
}

export function runCodex(options: RunCodexOptions): Promise<RunCodexResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<RunCodexResult>((resolve, reject) => {
    const startedAt = performance.now()
    const invocation = cliInvocation(options.codexCli, buildCodexArgs(options))
    const child = spawn(invocation.command, invocation.args, {
      // Strict allow-list env — a delegated worker must not inherit the MCP server's
      // secrets or parent-session vars (see shared/worker-env).
      env: buildWorkerEnv(),
      // stdin must NOT be an open pipe: codex exec treats piped stdin as additional
      // instructions and blocks until EOF (observed: full-timeout hang with
      // "Reading additional input from stdin..." and zero events emitted).
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
        .then(() => finalizeResult(code, options.paths, startedAt, guard.didTimeout()))
        .then(resolve)
    })
  })
}

async function finalizeResult(
  code: number | null,
  paths: JobPaths,
  startedAt: number,
  timedOut: boolean,
): Promise<RunCodexResult> {
  const exitCode = unmaskTimedOutExit(code ?? -1, timedOut)
  const lastMessage = await resolveLastMessage(paths)
  const failure = await resolveFailure(exitCode, paths)
  return {
    exitCode,
    lastMessage,
    durationMs: performance.now() - startedAt,
    ...failure,
  }
}

// Safe to classify from disk: streamsSettled guarantees both artifacts are flushed by close time.
async function resolveFailure(
  exitCode: number,
  paths: JobPaths,
): Promise<{ readonly failureKind?: FailureKind; readonly retryAtMs?: number }> {
  if (exitCode === 0) return { failureKind: undefined }
  const eventsNdjson = await readFile(paths.eventsFile, 'utf8').catch(() => '')
  const stderrText = await readFile(paths.stderrFile, 'utf8').catch(() => '')
  const text = `${eventsNdjson}\n${stderrText}`
  const failureKind = classifyCodexFailure({ exitCode, eventsNdjson, stderrText })
  const retryAtMs = failureKind === 'quota' ? parseRetryAt(text, Date.now()) : undefined
  return {
    failureKind,
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  }
}

async function resolveLastMessage(paths: JobPaths): Promise<string | null> {
  try {
    const raw = await readFile(paths.lastMessageFile, 'utf8')
    return raw.trim()
  } catch {
    const events = await readFile(paths.eventsFile, 'utf8').catch(() => '')
    return parseEvents(events).lastMessage
  }
}
