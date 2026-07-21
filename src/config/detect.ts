import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
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
  readonly executable?: string
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

async function resolveCodexBin(repoRoot: string): Promise<string> {
  const bundledPath = join(repoRoot, 'node_modules', '.bin', 'codex')
  try {
    await access(bundledPath)
    return bundledPath
  } catch {
    return 'codex'
  }
}

async function detectCodex(repoRoot: string): Promise<ProviderStaticDetection> {
  const codexBin = await resolveCodexBin(repoRoot)
  const status = await run(codexBin, ['login', 'status'])
  if (status.spawnErrorCode !== undefined) {
    return {
      engine: 'codex',
      available: false,
      detail: 'CLI not found — run: npm install',
      executable: codexBin,
      reports: [{ status: 'fail', message: 'codex CLI not found — run: npm install' }],
    }
  }

  const binaryReport = { status: 'ok', message: `codex binary: ${codexBin}` } as const
  if (status.exitCode !== 0) {
    return {
      engine: 'codex',
      available: false,
      detail: 'not authenticated — run: npx codex login',
      executable: codexBin,
      reports: [
        binaryReport,
        { status: 'fail', message: 'codex not authenticated — run: npx codex login' },
      ],
    }
  }

  return {
    engine: 'codex',
    available: true,
    detail: `binary: ${codexBin}`,
    executable: codexBin,
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
    detail: `binary: ${version}; live authentication check requires: npm run preflight`,
    reports: [{ status: 'ok', message: `claude binary: ${version}` }],
  }
}

export function detectAuthenticatedProvider(
  engine: EngineName,
  repoRoot: string,
): Promise<ProviderStaticDetection> {
  return engine === 'codex' ? detectCodex(repoRoot) : detectClaude()
}

export async function detectAuthenticatedProviders(
  repoRoot: string,
): Promise<Record<EngineName, ProviderDetection>> {
  const [codex, claude] = await Promise.all([
    detectAuthenticatedProvider('codex', repoRoot),
    detectAuthenticatedProvider('claude', repoRoot),
  ])
  return {
    codex: { available: codex.available, detail: codex.detail },
    claude: { available: claude.available, detail: claude.detail },
  }
}
