import { constants } from 'node:fs'
import { access, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { detectAuthenticatedProviders } from '../src/config/detect'
import { listAllProviderModels } from '../src/config/models'
import type { ModelOption, ProviderModels } from '../src/config/models'
import { writePolicyFile } from '../src/config/policy-writer'
import type { PolicyPatch } from '../src/config/policy-writer'
import type { Effort, EngineName } from '../src/types'

const PROVIDERS = ['codex', 'claude', 'antigravity'] as const satisfies readonly EngineName[]
const EFFORT_TIERS = ['light', 'standard', 'heavy'] as const satisfies readonly Effort[]

function isEngineName(value: string): value is EngineName {
  return value === 'codex' || value === 'claude' || value === 'antigravity'
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
  tierAnswers: Partial<Record<EngineName, Partial<Record<Effort, string>>>> = {},
): PolicyPatch {
  const models: NonNullable<PolicyPatch['models']> = {}
  for (const provider of chain) {
    const answeredTiers: Partial<Record<Effort, string>> = {}
    for (const tier of EFFORT_TIERS) {
      const model = tierAnswers[provider]?.[tier]?.trim() ?? ''
      if (model !== '') answeredTiers[tier] = model
    }
    if (Object.keys(answeredTiers).length > 0) {
      models[provider] = answeredTiers
      continue
    }

    const model = modelAnswers[provider]?.trim() ?? ''
    if (provider === 'claude') models.claude = model || 'sonnet'
    else if (model !== '') models[provider] = model
  }
  return { chain: [...chain], models }
}

export function resolveModelAnswer(
  answer: string,
  models: readonly ModelOption[],
): string {
  const trimmed = answer.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return answer

  const choice = Number(trimmed)
  if (!Number.isSafeInteger(choice) || choice < 1 || choice > models.length) {
    throw new Error(`Model number must be between 1 and ${models.length}`)
  }
  return models[choice - 1]!.id
}

export function formatModelMenu(
  provider: string,
  discovered: ProviderModels,
): readonly string[] {
  if (discovered.models.length === 0) return []

  const lines = [`${provider} models (newest first):`]
  for (const [index, model] of discovered.models.entries()) {
    const markers: string[] = []
    if (model.recommended === true) markers.push('(recommended)')
    if (model.id === discovered.defaultModel) markers.push('(local default)')
    const suffix = markers.length === 0 ? '' : ` ${markers.join(' ')}`
    lines.push(`  ${index + 1}. ${model.id}${suffix}`)
  }
  if (discovered.source === 'catalog') {
    lines.push('  Catalog list is indicative; you can type any model id.')
  }
  return lines
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

function printModelMenu(provider: EngineName, discovered: ProviderModels): void {
  for (const line of formatModelMenu(provider, discovered)) console.log(line)
}

async function askForModel(
  readline: ReturnType<typeof createInterface>,
  prompt: string,
  models: readonly ModelOption[],
): Promise<string> {
  while (true) {
    const answer = await readline.question(prompt)
    try {
      return resolveModelAnswer(answer, models)
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error))
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = process.cwd()
  if (!process.stdin.isTTY) {
    await useDefaultPolicy(repoRoot)
    return
  }

  const detected = await detectAuthenticatedProviders(repoRoot)
  const providerModels = await listAllProviderModels(repoRoot)
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
  console.log('The chain is a priority order.')
  console.log('Provider 1 receives every delegated job; later providers are automatic fallbacks.')
  console.log('They are used only when an earlier provider hits a quota or auth wall.')

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
      printModelMenu(provider, providerModels[provider])
      const defaultHint = provider === 'claude' ? ' [sonnet]' : ' [provider default]'
      modelAnswers[provider] = await askForModel(
        readline,
        `${provider} model${defaultHint}: `,
        providerModels[provider].models,
      )
    }

    const tierAnswers: Partial<
      Record<EngineName, Partial<Record<Effort, string>>>
    > = {}
    const configureTiers = await readline.question(
      'Configure per-effort model tiers (light/standard/heavy)? [y/N]: ',
    )
    if (['y', 'yes'].includes(configureTiers.trim().toLowerCase())) {
      for (const provider of chain) {
        printModelMenu(provider, providerModels[provider])
        const answers: Partial<Record<Effort, string>> = {}
        for (const tier of EFFORT_TIERS) {
          answers[tier] = await askForModel(
            readline,
            `${provider} ${tier} model [skip]: `,
            providerModels[provider].models,
          )
        }
        tierAnswers[provider] = answers
      }
    }
    const patch = buildPolicyPatch(chain, modelAnswers, tierAnswers)

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
      const configured = patch.models?.[provider]
      if (configured === undefined || typeof configured === 'string') {
        console.log(`  ${provider} model: ${configured ?? 'provider default'}`)
        continue
      }
      const tiers = EFFORT_TIERS.filter((tier) => configured[tier] !== undefined)
        .map((tier) => `${tier}=${configured[tier]}`)
        .join(', ')
      console.log(`  ${provider} models: ${tiers}`)
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
