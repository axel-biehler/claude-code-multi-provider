import { constants } from 'node:fs'
import { access, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { detectAuthenticatedProviders } from '../src/config/detect'
import { writePolicyFile } from '../src/config/policy-writer'
import type { PolicyPatch } from '../src/config/policy-writer'
import type { EngineName } from '../src/types'

const PROVIDERS = ['codex', 'claude'] as const satisfies readonly EngineName[]

function isEngineName(value: string): value is EngineName {
  return value === 'codex' || value === 'claude'
}

export function parseProviderSelection(
  answer: string,
  available: readonly EngineName[],
): EngineName[] {
  const requested = answer.trim() === '' ? [...available] : answer.trim().split(/[\s,]+/)
  if (requested.length === 0) throw new Error('Choose at least one provider')

  const chain: EngineName[] = []
  for (const provider of requested) {
    if (!isEngineName(provider)) throw new Error(`Unknown provider: ${provider}`)
    if (!available.includes(provider)) throw new Error(`${provider} is not available`)
    if (chain.includes(provider)) throw new Error(`${provider} was selected more than once`)
    chain.push(provider)
  }
  return chain
}

export function buildPolicyPatch(
  chain: readonly EngineName[],
  modelAnswers: Partial<Record<EngineName, string>>,
): PolicyPatch {
  const models: Partial<Record<EngineName, string>> = {}
  for (const provider of chain) {
    const model = modelAnswers[provider]?.trim() ?? ''
    if (provider === 'claude') models.claude = model || 'sonnet'
    else if (model !== '') models.codex = model
  }
  return { chain: [...chain], models }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function ensureDefaultPolicy(repoRoot: string): Promise<boolean> {
  const examplePath = join(repoRoot, 'policy.example.yaml')
  const policyPath = join(repoRoot, 'policy.yaml')
  try {
    await copyFile(examplePath, policyPath, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
}

async function policyExists(repoRoot: string): Promise<boolean> {
  try {
    await access(join(repoRoot, 'policy.yaml'))
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

async function useDefaultPolicy(repoRoot: string): Promise<void> {
  const created = await ensureDefaultPolicy(repoRoot)
  console.log(
    created
      ? 'policy.yaml created from policy.example.yaml'
      : 'policy.yaml already exists — keeping it unchanged',
  )
}

async function main(): Promise<void> {
  const repoRoot = process.cwd()
  if (!process.stdin.isTTY) {
    await useDefaultPolicy(repoRoot)
    return
  }

  const detected = await detectAuthenticatedProviders(repoRoot)
  const available = PROVIDERS.filter((provider) => detected[provider].available)
  if (available.length === 0) {
    console.log('No authenticated providers detected.')
    console.log('Run npm run preflight for details, then log in:')
    console.log('  Codex:  npx codex login')
    console.log('  Claude: claude setup-token')
    await useDefaultPolicy(repoRoot)
    return
  }

  console.log('Available providers:')
  for (const provider of available) console.log(`  ${provider}: ${detected[provider].detail}`)

  // @types/node 26 types Readable[Symbol.asyncIterator] as NodeJS.AsyncIterator, but
  // ReadLineOptions.input expects AsyncIterableIterator — a defs skew, not a runtime one
  // (this is the canonical process.stdin/stdout usage from the readline/promises docs).
  const readline = createInterface({
    input: process.stdin as unknown as NodeJS.ReadableStream,
    output: process.stdout,
  })
  try {
    let chain: EngineName[] | undefined
    while (chain === undefined) {
      const answer = await readline.question(
        `Providers in order (comma-separated) [${available.join(', ')}]: `,
      )
      try {
        chain = parseProviderSelection(answer, available)
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error))
      }
    }

    const modelAnswers: Partial<Record<EngineName, string>> = {}
    for (const provider of chain) {
      const defaultHint = provider === 'claude' ? ' [sonnet]' : ' [provider default]'
      modelAnswers[provider] = await readline.question(`${provider} model${defaultHint}: `)
    }
    const patch = buildPolicyPatch(chain, modelAnswers)

    if (await policyExists(repoRoot)) {
      const confirmation = await readline.question(
        'policy.yaml exists. Change its chain and selected models? [y/N]: ',
      )
      if (!['y', 'yes'].includes(confirmation.trim().toLowerCase())) {
        console.log('Keeping policy.yaml unchanged.')
        return
      }
    }

    await writePolicyFile(repoRoot, patch)
    console.log(`Configured chain: ${chain.join(' -> ')}`)
    for (const provider of chain) {
      console.log(`  ${provider} model: ${patch.models?.[provider] ?? 'provider default'}`)
    }
    console.log('Run npm run preflight for a live authentication check.')
  } finally {
    readline.close()
  }
}

const entryPath = process.argv[1]
const isDirectRun =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
