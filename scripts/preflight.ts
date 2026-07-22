import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectAuthenticatedProvider } from '../src/config/detect'
import { classifyAntigravityFailure, parseAntigravityJson } from '../src/engines/antigravity'
import { cliInvocation } from '../src/engines/shared/cli-command'
import type { CliCommand } from '../src/engines/shared/cli-command'
import { classifyClaudeFailure, parseClaudeJson } from '../src/engines/claude'
import { classifyCodexFailure } from '../src/engines/codex'
import { buildWorkerEnv } from '../src/engines/shared/worker-env'
import { loadPolicy } from '../src/routing/policy'
import type { Policy } from '../src/routing/policy'
import { QuotaLedger } from '../src/routing/quota'
import type { EngineName, FailureKind } from '../src/types'

const NODE_MAJOR_MIN = 20
const PROBE_TIMEOUT_MS = 120_000
const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const CODEX_PROBE_PROMPT = 'Reply with the single word: ok'
const CLAUDE_PROBE_PROMPT = 'Reply with exactly: ok'
const CLAUDE_PROBE_MODEL = 'sonnet'
const ANTIGRAVITY_PROBE_PROMPT = 'Reply with exactly: ok'
const ANTIGRAVITY_PROBE_MODEL = 'gemini-3.5-flash-low'
// Measured floor: a minimal `claude -p` costs ~$0.41 just to boot (≈69k cache-creation
// tokens of CLI system prompt), so the cap must sit well above it. Guard, not a target.
const CLAUDE_PROBE_BUDGET_USD = '1'
const QUOTA_VERDICT = 'quota exhausted — rerouting/backoff will apply'

export interface PreflightArgs {
  readonly probe: boolean
}

export function parsePreflightArgs(argv: readonly string[]): PreflightArgs {
  return { probe: !argv.includes('--no-probe') }
}

export interface EngineUsability {
  readonly engine: string
  readonly staticOk: boolean
  // null = probe did not run (skipped or static already failed) → static verdict only.
  readonly probeOk: boolean | null
}

export interface PreflightVerdict {
  readonly exitCode: 0 | 1
  readonly usableEngines: readonly string[]
}

// The router only needs ONE live engine — sick engines are reported, never blocking,
// but node/git/policy are load-bearing for every delegation and always gate.
export function computeVerdict(input: {
  readonly coreOk: boolean
  readonly engines: ReadonlyArray<EngineUsability>
}): PreflightVerdict {
  const usableEngines = input.engines
    .filter((candidate) => candidate.staticOk && (candidate.probeOk ?? true))
    .map((candidate) => candidate.engine)
  return {
    exitCode: input.coreOk && usableEngines.length > 0 ? 0 : 1,
    usableEngines,
  }
}

interface Reporter {
  readonly ok: (message: string) => void
  readonly fail: (message: string) => void
  readonly info: (message: string) => void
  readonly failureCount: () => number
}

function createReporter(): Reporter {
  let failures = 0
  return {
    ok: (message) => console.log(`ok:   ${message}`),
    fail: (message) => {
      failures += 1
      console.log(`FAIL: ${message}`)
    },
    info: (message) => console.log(`info: ${message}`),
    failureCount: () => failures,
  }
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly spawnErrorCode?: string
}

interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
}

// Buffered, never-throwing execFile: checks and probes need exitCode + output however
// the child died (non-zero exit → numeric code; ENOENT → string code; timeout → killed).
function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      command,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: EXEC_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ exitCode: 0, stdout, stderr, timedOut: false })
          return
        }
        const raw = error as { code?: unknown; killed?: unknown }
        resolvePromise({
          exitCode: typeof raw.code === 'number' ? raw.code : -1,
          stdout,
          stderr,
          timedOut: raw.killed === true,
          spawnErrorCode: typeof raw.code === 'string' ? raw.code : undefined,
        })
      },
    )
    // Phase-0 finding 1, probe edition: an open stdin pipe makes CLIs stall waiting for
    // input (codex blocks outright; claude warns after 3s). Immediate EOF instead.
    child.stdin?.end()
  })
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

function checkNode(reporter: Reporter): boolean {
  const version = process.versions.node
  const major = Number(version.split('.')[0])
  if (!Number.isInteger(major) || major < NODE_MAJOR_MIN) {
    reporter.fail(`node >= ${NODE_MAJOR_MIN} required (found v${version})`)
    return false
  }
  reporter.ok(`node v${version}`)
  return true
}

// Worktrees need a valid HEAD to branch from.
async function checkGit(reporter: Reporter, repoRoot: string): Promise<boolean> {
  const result = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    reporter.fail('not a git repo with an initial commit — run: git init && git commit')
    return false
  }
  reporter.ok('git repo with HEAD commit')
  return true
}

async function checkPolicy(reporter: Reporter, repoRoot: string): Promise<Policy | null> {
  try {
    const policy = await loadPolicy(repoRoot)
    reporter.ok(`policy chain: ${policy.chain.join('>')}`)
    return policy
  } catch (error) {
    reporter.fail(error instanceof Error ? error.message : String(error))
    return null
  }
}

interface StaticCheckOutcome {
  readonly engine: EngineName
  readonly staticOk: boolean
  readonly codexCli?: CliCommand
}

async function checkEngineStatic(
  reporter: Reporter,
  repoRoot: string,
  engine: EngineName,
): Promise<StaticCheckOutcome> {
  const detection = await detectAuthenticatedProvider(engine, repoRoot)
  for (const report of detection.reports) {
    reporter[report.status](report.message)
  }
  return {
    engine,
    staticOk: detection.available,
    codexCli: engine === 'codex' ? detection.cli : undefined,
  }
}

// Advisory only: the ledger is our own proxy for vendor windows, not ground truth —
// the live probes below are what actually verify usability.
async function reportLedgerHeadroom(
  reporter: Reporter,
  repoRoot: string,
  policy: Policy,
  chainEngines: readonly EngineName[],
): Promise<void> {
  const ledger = await QuotaLedger.load(repoRoot)
  const { exhaustedUntil } = ledger.snapshot()
  for (const engine of chainEngines) {
    const headroom = ledger.hasHeadroom(engine, policy.quotas[engine])
    const until = exhaustedUntil[engine]
    const cooldown =
      until !== undefined && until > Date.now()
        ? ` (cooldown until ${new Date(until).toISOString()})`
        : ''
    reporter.info(`${engine} ledger headroom: ${headroom ? 'yes' : 'no'}${cooldown}`)
  }
}

function describeOtherFailure(result: RunResult): string {
  if (result.timedOut) return `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`
  return firstLine(result.stderr) || `exited ${result.exitCode} with no stderr output`
}

function describeCodexProbeFailure(kind: FailureKind, result: RunResult): string {
  if (kind === 'quota') return QUOTA_VERDICT
  if (kind === 'auth') return 'token invalid — run: npx codex login'
  return describeOtherFailure(result)
}

async function probeCodex(reporter: Reporter, codexCli: CliCommand): Promise<boolean> {
  // -c mcp_servers={} keeps the user's personal ~/.codex/config.toml MCP servers out of
  // the probe (same override the delegation adapter uses).
  const invocation = cliInvocation(codexCli, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'mcp_servers={}',
    CODEX_PROBE_PROMPT,
  ])
  const result = await run(invocation.command, invocation.args, {
    timeoutMs: PROBE_TIMEOUT_MS,
    env: buildWorkerEnv(),
  })
  if (result.exitCode === 0) {
    reporter.ok('codex probe: usable')
    return true
  }
  const kind =
    classifyCodexFailure({
      exitCode: result.exitCode,
      eventsNdjson: result.stdout,
      stderrText: result.stderr,
    }) ?? 'other'
  reporter.fail(`codex probe: ${describeCodexProbeFailure(kind, result)}`)
  return false
}

// claude -p reports failures inside the stdout result JSON (stderr often stays empty).
function claudeJsonError(resultJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(resultJson)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { errors, subtype } = parsed as { readonly errors?: unknown; readonly subtype?: unknown }
    if (Array.isArray(errors) && typeof errors[0] === 'string') return errors[0]
    return typeof subtype === 'string' ? subtype : null
  } catch {
    return null
  }
}

function describeClaudeProbeFailure(kind: FailureKind, result: RunResult): string {
  if (kind === 'quota') return QUOTA_VERDICT
  if (kind === 'auth') return 'token stale/revoked — run: claude setup-token'
  if (result.exitCode === 0) return 'exited 0 but returned no parseable result JSON'
  return claudeJsonError(result.stdout) ?? describeOtherFailure(result)
}

async function probeClaude(reporter: Reporter): Promise<boolean> {
  const result = await run(
    'claude',
    [
      '-p',
      CLAUDE_PROBE_PROMPT,
      '--output-format',
      'json',
      '--model',
      CLAUDE_PROBE_MODEL,
      '--max-budget-usd',
      CLAUDE_PROBE_BUDGET_USD,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS, env: buildWorkerEnv() },
  )
  if (result.exitCode === 0 && parseClaudeJson(result.stdout).lastMessage !== null) {
    reporter.ok('claude probe: usable')
    return true
  }
  const kind =
    classifyClaudeFailure({
      exitCode: result.exitCode,
      resultJson: result.stdout,
      stderrText: result.stderr,
    }) ?? 'other'
  reporter.fail(`claude probe: ${describeClaudeProbeFailure(kind, result)}`)
  return false
}

async function probeAntigravity(reporter: Reporter): Promise<boolean> {
  const result = await run(
    'agy',
    [
      '-p',
      ANTIGRAVITY_PROBE_PROMPT,
      '--output-format',
      'json',
      '--model',
      ANTIGRAVITY_PROBE_MODEL,
      '--print-timeout',
      '120s',
    ],
    { timeoutMs: PROBE_TIMEOUT_MS, env: buildWorkerEnv() },
  )
  if (result.exitCode === 0 && parseAntigravityJson(result.stdout).lastMessage !== null) {
    reporter.ok('antigravity probe: usable')
    return true
  }
  const kind =
    classifyAntigravityFailure({
      exitCode: result.exitCode,
      resultJson: result.stdout,
      stderrText: result.stderr,
    }) ?? 'other'
  const detail =
    kind === 'quota'
      ? QUOTA_VERDICT
      : kind === 'auth'
        ? 'not logged in — sign in via the Antigravity app'
        : describeOtherFailure(result)
  reporter.fail(`antigravity probe: ${detail}`)
  return false
}

// Probing an engine whose static checks already failed would burn a real request on a
// known-broken setup — null keeps the static verdict authoritative for it.
async function runProbe(reporter: Reporter, outcome: StaticCheckOutcome): Promise<boolean | null> {
  if (!outcome.staticOk) return null
  if (outcome.engine === 'codex') {
    return probeCodex(reporter, outcome.codexCli ?? { command: 'codex', args: [] })
  }
  if (outcome.engine === 'antigravity') return probeAntigravity(reporter)
  return probeClaude(reporter)
}

async function checkEngines(
  reporter: Reporter,
  repoRoot: string,
  policy: Policy,
  probe: boolean,
): Promise<readonly EngineUsability[]> {
  const chainEngines = [...new Set(policy.chain)]

  const statics: StaticCheckOutcome[] = []
  for (const engine of chainEngines) {
    statics.push(await checkEngineStatic(reporter, repoRoot, engine))
  }

  await reportLedgerHeadroom(reporter, repoRoot, policy, chainEngines)

  if (!probe) {
    reporter.info('live probes skipped (--no-probe)')
    return statics.map((outcome) => ({
      engine: outcome.engine,
      staticOk: outcome.staticOk,
      probeOk: null,
    }))
  }

  const engines: EngineUsability[] = []
  for (const outcome of statics) {
    engines.push({
      engine: outcome.engine,
      staticOk: outcome.staticOk,
      probeOk: await runProbe(reporter, outcome),
    })
  }
  return engines
}

function printSummary(reporter: Reporter, verdict: PreflightVerdict): void {
  if (verdict.exitCode !== 0) {
    console.log(`preflight: ${reporter.failureCount()} check(s) failed`)
    return
  }
  if (reporter.failureCount() === 0) {
    console.log('preflight: all checks passed')
    return
  }
  console.log(
    `preflight: passed — usable engine(s): ${verdict.usableEngines.join(', ')} ` +
      `(${reporter.failureCount()} non-blocking check(s) failed)`,
  )
}

async function main(): Promise<void> {
  const { probe } = parsePreflightArgs(process.argv.slice(2))
  const repoRoot = process.cwd()
  const reporter = createReporter()

  const nodeOk = checkNode(reporter)
  const gitOk = await checkGit(reporter, repoRoot)
  const policy = await checkPolicy(reporter, repoRoot)
  const coreOk = nodeOk && gitOk && policy !== null

  const engines = policy === null ? [] : await checkEngines(reporter, repoRoot, policy, probe)

  const verdict = computeVerdict({ coreOk, engines })
  printSummary(reporter, verdict)
  process.exit(verdict.exitCode)
}

// Tests import the pure functions above — only a direct `tsx scripts/preflight.ts` runs the CLI.
const entryPath = process.argv[1]
const isDirectRun =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
