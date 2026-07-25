import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveMammouthBin } from '../engines/mammouth'
import type { EngineName } from '../types'

const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024

export interface ModelOption {
  readonly id: string
  readonly recommended?: boolean
}

export interface ProviderModels {
  readonly models: readonly ModelOption[]
  readonly source: 'cli' | 'catalog'
  readonly defaultModel?: string
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
}

const ANTIGRAVITY_CATALOG: readonly ModelOption[] = [
  { id: 'gemini-3.6-flash-high', recommended: true },
  { id: 'gemini-3.6-flash-medium' },
  { id: 'gemini-3.6-flash-low' },
  { id: 'claude-sonnet-4-6' },
]

// Claude aliases follow the latest model in each tier, unlike versioned model ids.
const CLAUDE_CATALOG: readonly ModelOption[] = [
  { id: 'fable' },
  { id: 'opus' },
  { id: 'sonnet', recommended: true },
  { id: 'haiku' },
]

function antigravityFallback(): ProviderModels {
  return { models: ANTIGRAVITY_CATALOG, source: 'catalog' }
}

function codexFallback(): ProviderModels {
  return { models: [], source: 'catalog' }
}

function kimiFallback(): ProviderModels {
  return { models: [], source: 'catalog' }
}

function mammouthFallback(): ProviderModels {
  return { models: [], source: 'catalog' }
}

function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    try {
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
          })
        },
      )
      child.stdin?.end()
    } catch {
      resolvePromise({ exitCode: -1, stdout: '' })
    }
  })
}

export function parseLineModelsOutput(stdout: string): readonly ModelOption[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((id, index) => (index === 0 ? { id, recommended: true } : { id }))
}

export function parseCodexConfigModel(toml: string): string | undefined {
  // Only one top-level scalar is needed, so a line scan avoids a TOML dependency.
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return undefined

    const match = /^\s*model\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

export function parseKimiConfigModel(toml: string): string | undefined {
  // Only one top-level scalar is needed, so a line scan avoids a TOML dependency.
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return undefined

    const match = /^\s*default_model\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

async function listAntigravityModels(): Promise<ProviderModels> {
  const result = await run('agy', ['models'])
  if (result.exitCode !== 0) return antigravityFallback()
  return { models: parseLineModelsOutput(result.stdout), source: 'cli' }
}

export async function listMammouthModels(): Promise<ProviderModels> {
  const result = await run(await resolveMammouthBin(), ['models'])
  if (result.exitCode !== 0) return mammouthFallback()
  return { models: parseLineModelsOutput(result.stdout), source: 'cli' }
}

async function listCodexModels(): Promise<ProviderModels> {
  let config: string
  try {
    config = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8')
  } catch {
    return codexFallback()
  }

  const model = parseCodexConfigModel(config)
  if (model === undefined) return codexFallback()
  return {
    models: [{ id: model, recommended: true }],
    source: 'catalog',
    defaultModel: model,
  }
}

export async function listKimiModels(): Promise<ProviderModels> {
  let config: string
  try {
    config = await readFile(join(homedir(), '.kimi-code', 'config.toml'), 'utf8')
  } catch {
    return kimiFallback()
  }

  const model = parseKimiConfigModel(config)
  if (model === undefined) return kimiFallback()
  return {
    models: [{ id: model, recommended: true }],
    source: 'catalog',
    defaultModel: model,
  }
}

async function listClaudeModels(): Promise<ProviderModels> {
  return {
    models: CLAUDE_CATALOG,
    source: 'catalog',
    defaultModel: 'sonnet',
  }
}

export function listProviderModels(
  engine: EngineName,
  repoRoot: string,
): Promise<ProviderModels> {
  if (engine === 'antigravity') return listAntigravityModels()
  if (engine === 'mammouth') return listMammouthModels()
  if (engine === 'codex') return listCodexModels()
  if (engine === 'kimi') return listKimiModels()
  return listClaudeModels()
}

export async function listAllProviderModels(
  repoRoot: string,
): Promise<Record<EngineName, ProviderModels>> {
  const [codex, claude, antigravity, kimi, mammouth] = await Promise.all([
    listProviderModels('codex', repoRoot).catch(codexFallback),
    listProviderModels('claude', repoRoot).catch(listClaudeModels),
    listProviderModels('antigravity', repoRoot).catch(antigravityFallback),
    listProviderModels('kimi', repoRoot).catch(kimiFallback),
    listProviderModels('mammouth', repoRoot).catch(mammouthFallback),
  ])
  return { codex, claude, antigravity, kimi, mammouth }
}
