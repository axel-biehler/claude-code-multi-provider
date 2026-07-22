import { constants } from 'node:fs'
import { access, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { detectAuthenticatedProviders } from '../src/config/detect'
import { MODEL_SUGGESTIONS, TIER_SUGGESTIONS } from '../src/config/model-catalog'
import type { ModelSuggestion } from '../src/config/model-catalog'
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
): PolicyPatch {
  const models: Partial<Record<EngineName, string>> = {}
  for (const provider of chain) {
    const model = modelAnswers[provider]?.trim() ?? ''
    if (provider === 'claude') models.claude = model || 'sonnet'
    else if (model !== '') models[provider] = model
  }
  return { chain: [...chain], models }
}

// '' = provider default; a bare number picks from the suggestion menu; anything else
// is taken verbatim (suggestions are hints, not a validation list).
export function parseModelChoice(
  answer: string,
  suggestions: readonly ModelSuggestion[],
): string {
  const trimmed = answer.trim()
  if (trimmed === '') return ''
  if (/^\d+$/.test(trimmed)) {
    const suggestion = suggestions[Number(trimmed) - 1]
    if (suggestion === undefined) throw new Error(`No suggestion #${trimmed}`)
    return suggestion.id
  }
  return trimmed
}

// Blank answers accept the suggested tier preset when one exists, else skip the tier.
export function parseTierChoice(
  answer: string,
  suggestions: readonly ModelSuggestion[],
  suggestedDefault: string | undefined,
): string | undefined {
  const choice = parseModelChoice(answer, suggestions)
  return choice === '' ? suggestedDefault : choice
}

export function buildTierPatch(
  tierAnswers: Partial<Record<EngineName, Partial<Record<Effort, string>>>>,
): PolicyPatch | null {
  const models: NonNullable<PolicyPatch['models']> = {}
  for (const [engine, tiers] of Object.entries(tierAnswers)) {
    if (tiers === undefined || Object.keys(tiers).length === 0) continue
    models[engine as EngineName] = tiers
  }
  return Object.keys(models).length === 0 ? null : { models }
}

export function formatModelMenu(provider: EngineName): string[] {
  const header = `${provider} — suggested models (any other id is accepted):`
  const rows = MODEL_SUGGESTIONS[provider].map((suggestion, index) => {
    const note = suggestion.note === undefined ? '' : ` — ${suggestion.note}`
    return `  ${index + 1}. ${suggestion.id}${note}`
  })
  return [header, ...rows]
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

interface Prompt {
  readonly question: (query: string) => Promise<string>
}

function isYes(answer: string): boolean {
  return ['y', 'yes'].includes(answer.trim().toLowerCase())
}

async function askBaseModel(prompt: Prompt, provider: EngineName): Promise<string> {
  for (const line of formatModelMenu(provider)) console.log(line)
  const hint = provider === 'claude' ? 'empty = sonnet' : 'empty = provider default'
  for (;;) {
    const answer = await prompt.question(`${provider} model [number, id, or ${hint}]: `)
    try {
      return parseModelChoice(answer, MODEL_SUGGESTIONS[provider])
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error))
    }
  }
}

async function askProviderTiers(
  prompt: Prompt,
  provider: EngineName,
): Promise<Partial<Record<Effort, string>>> {
  const tiers: Partial<Record<Effort, string>> = {}
  for (const tier of EFFORT_TIERS) {
    const fallback = TIER_SUGGESTIONS[provider]?.[tier]
    const hint = fallback === undefined ? 'empty = skip' : `empty = ${fallback}`
    for (;;) {
      const answer = await prompt.question(
        `${provider} ${tier} model [number, id, or ${hint}]: `,
      )
      try {
        const model = parseTierChoice(answer, MODEL_SUGGESTIONS[provider], fallback)
        if (model !== undefined) tiers[tier] = model
        break
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error))
      }
    }
  }
  return tiers
}

// delegate_task's engine-neutral `effort` hint (light|standard|heavy) picks a tier at
// job time; an unset tier falls back to the provider's base model.
async function askTiers(
  prompt: Prompt,
  chain: readonly EngineName[],
): Promise<Partial<Record<EngineName, Partial<Record<Effort, string>>>>> {
  const tierAnswers: Partial<Record<EngineName, Partial<Record<Effort, string>>>> = {}
  for (const provider of chain) {
    const wanted = await prompt.question(
      `Configure per-effort model tiers for ${provider}? [y/N]: `,
    )
    if (!isYes(wanted)) continue
    const tiers = await askProviderTiers(prompt, provider)
    if (Object.keys(tiers).length > 0) tierAnswers[provider] = tiers
  }
  return tierAnswers
}

function printSelectionSummary(
  chain: readonly EngineName[],
  patch: PolicyPatch,
  tierAnswers: Partial<Record<EngineName, Partial<Record<Effort, string>>>>,
): void {
  console.log(`Configured chain: ${chain.join(' -> ')}`)
  for (const provider of chain) {
    console.log(`  ${provider} model: ${patch.models?.[provider] ?? 'provider default'}`)
    const tiers = tierAnswers[provider]
    if (tiers === undefined) continue
    const rendered = EFFORT_TIERS.filter((tier) => tiers[tier] !== undefined)
      .map((tier) => `${tier}=${tiers[tier]}`)
      .join(', ')
    console.log(`  ${provider} tiers: ${rendered}`)
  }
  console.log('Run npm run preflight for a live authentication check.')
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
      modelAnswers[provider] = await askBaseModel(readline, provider)
    }
    const tierAnswers = await askTiers(readline, chain)
    const patch = buildPolicyPatch(chain, modelAnswers)
    const tierPatch = buildTierPatch(tierAnswers)

    if (await policyExists(repoRoot)) {
      const confirmation = await readline.question(
        'policy.yaml exists. Change its chain and selected models? [y/N]: ',
      )
      if (!isYes(confirmation)) {
        console.log('Keeping policy.yaml unchanged.')
        return
      }
    }

    await writePolicyFile(repoRoot, patch)
    // Second merge-safe pass: `model` (scalar) and `models.<tier>` are distinct YAML
    // paths, and one patch entry can only carry one form per provider.
    if (tierPatch !== null) await writePolicyFile(repoRoot, tierPatch)
    printSelectionSummary(chain, patch, tierAnswers)
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
