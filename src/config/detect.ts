import { execFile } from 'node:child_process'
import {
  cliInvocation,
  describeCli,
  resolveCodexCli,
  resolveKimiBin,
} from '../engines/shared/cli-command'
import type { CliCommand } from '../engines/shared/cli-command'
import type { EngineName } from '../types'

const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024

export interface ProviderDetection {
  readonly available: boolean
  readonly detail: string
}

export interface DetectionReport {
  readonly status: 'ok' | 'fail'
  readonly message: string
}

export interface ProviderStaticDetection extends ProviderDetection {
  readonly engine: EngineName
  readonly cli?: CliCommand
  readonly reports: readonly DetectionReport[]
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly spawnErrorCode?: string
}

// Static detection must not leak child output: this module is also safe to load
// inside a stdio JSON-RPC server.
function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      command,
      [...args],
      { maxBuffer: EXEC_MAX_BUFFER_BYTES },
      (error, stdout) => {
        if (error === null) {
          resolvePromise({ exitCode: 0, stdout })
          return
        }
        const raw = error as { code?: unknown }
        resolvePromise({
          exitCode: typeof raw.code === 'number' ? raw.code : -1,
          stdout,
          spawnErrorCode: typeof raw.code === 'string' ? raw.code : undefined,
        })
      },
    )
    child.stdin?.end()
  })
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

async function detectCodex(repoRoot: string): Promise<ProviderStaticDetection> {
  const codexCli = await resolveCodexCli(repoRoot)
  const invocation = cliInvocation(codexCli, ['login', 'status'])
  const status = await run(invocation.command, invocation.args)
  if (status.spawnErrorCode !== undefined) {
    return {
      engine: 'codex',
      available: false,
      detail: 'CLI not found on PATH — install: npm i -g @openai/codex && codex login',
      cli: codexCli,
      reports: [{ status: 'fail', message: 'codex CLI not found on PATH — install: npm i -g @openai/codex && codex login' }],
    }
  }

  const codexLabel = describeCli(codexCli)
  const binaryReport = { status: 'ok', message: `codex binary: ${codexLabel}` } as const
  if (status.exitCode !== 0) {
    return {
      engine: 'codex',
      available: false,
      detail: 'not authenticated — run: codex login',
      cli: codexCli,
      reports: [
        binaryReport,
        { status: 'fail', message: 'codex not authenticated — run: codex login' },
      ],
    }
  }

  return {
    engine: 'codex',
    available: true,
    detail: `binary: ${codexLabel}`,
    cli: codexCli,
    reports: [binaryReport, { status: 'ok', message: 'codex authenticated' }],
  }
}

async function detectClaude(): Promise<ProviderStaticDetection> {
  const result = await run('claude', ['--version'])
  if (result.spawnErrorCode !== undefined || result.exitCode !== 0) {
    return {
      engine: 'claude',
      available: false,
      detail: 'CLI not found on PATH — install the Claude Code CLI',
      reports: [
        { status: 'fail', message: 'claude CLI not found on PATH — install the Claude Code CLI' },
      ],
    }
  }

  const version = firstLine(result.stdout)
  return {
    engine: 'claude',
    available: true,
    detail: `binary: ${version}; authentication is verified when the first delegated job runs`,
    reports: [{ status: 'ok', message: `claude binary: ${version}` }],
  }
}

export async function detectAntigravity(): Promise<ProviderStaticDetection> {
  const result = await run('agy', ['--version'])
  if (result.spawnErrorCode !== undefined || result.exitCode !== 0) {
    return {
      engine: 'antigravity',
      available: false,
      detail: 'agy CLI not found on PATH — install the Antigravity CLI',
      reports: [
        {
          status: 'fail',
          message: 'agy CLI not found on PATH — install the Antigravity CLI',
        },
      ],
    }
  }

  const version = firstLine(result.stdout)
  return {
    engine: 'antigravity',
    available: true,
    detail: `binary: ${version}; authentication is verified when the first delegated job runs`,
    reports: [{ status: 'ok', message: `antigravity binary: ${version}` }],
  }
}

export async function detectKimi(): Promise<ProviderStaticDetection> {
  const result = await run(await resolveKimiBin(), ['--version'])
  const missingDetail =
    'kimi CLI not found — install Kimi Code CLI (https://code.kimi.com) and run: kimi login'
  if (result.spawnErrorCode !== undefined || result.exitCode !== 0) {
    return {
      engine: 'kimi',
      available: false,
      detail: missingDetail,
      reports: [{ status: 'fail', message: missingDetail }],
    }
  }

  const version = firstLine(result.stdout)
  return {
    engine: 'kimi',
    available: true,
    detail: `binary: ${version}; authentication is verified when the first delegated job runs`,
    reports: [{ status: 'ok', message: `kimi binary: ${version}` }],
  }
}

export function detectAuthenticatedProvider(
  engine: EngineName,
  repoRoot: string,
): Promise<ProviderStaticDetection> {
  if (engine === 'codex') return detectCodex(repoRoot)
  if (engine === 'antigravity') return detectAntigravity()
  if (engine === 'kimi') return detectKimi()
  return detectClaude()
}

export async function detectAuthenticatedProviders(
  repoRoot: string,
): Promise<Record<EngineName, ProviderDetection>> {
  const [codex, claude, antigravity, kimi] = await Promise.all([
    detectAuthenticatedProvider('codex', repoRoot),
    detectAuthenticatedProvider('claude', repoRoot),
    detectAuthenticatedProvider('antigravity', repoRoot),
    detectAuthenticatedProvider('kimi', repoRoot),
  ])
  return {
    codex: { available: codex.available, detail: codex.detail },
    claude: { available: claude.available, detail: claude.detail },
    antigravity: { available: antigravity.available, detail: antigravity.detail },
    kimi: { available: kimi.available, detail: kimi.detail },
  }
}
