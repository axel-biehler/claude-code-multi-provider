import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isScalar, parse, parseDocument, stringify } from 'yaml'
import { DEFAULT_POLICY, EffortSchema, EngineNameSchema, PolicySchema } from '../routing/policy'
import type { Policy } from '../routing/policy'
import type { Effort, EngineName } from '../types'

export interface PolicyPatch {
  readonly chain?: Policy['chain']
  readonly models?: Partial<
    Record<EngineName, string | Partial<Record<Effort, string>>>
  >
  readonly reasoning?: Partial<
    Record<EngineName, string | Partial<Record<Effort, string>>>
  >
}

export function renderPolicyYaml(current: string | null, patch: PolicyPatch): string {
  const document = parseDocument(current ?? stringify(DEFAULT_POLICY))
  if (document.errors.length > 0) {
    throw new Error(`Invalid policy YAML: ${document.errors.map((error) => error.message).join('; ')}`)
  }

  if (patch.chain !== undefined) {
    const chain = patch.chain.map((engine) => EngineNameSchema.parse(engine))
    document.set('chain', chain)
  }

  for (const [rawEngine, value] of Object.entries(patch.models ?? {})) {
    if (value === undefined) continue
    const engine = EngineNameSchema.parse(rawEngine)
    if (typeof value === 'string') {
      const path = ['workers', engine, 'model'] as const
      const currentModel = document.getIn(path, true)
      if (isScalar(currentModel)) currentModel.value = value
      else document.setIn(path, value)
    } else {
      for (const [rawTier, model] of Object.entries(value)) {
        const tier = EffortSchema.parse(rawTier)
        document.setIn(['workers', engine, 'models', tier], model)
      }
    }
  }

  for (const [rawEngine, value] of Object.entries(patch.reasoning ?? {})) {
    if (value === undefined) continue
    const engine = EngineNameSchema.parse(rawEngine)
    const path = ['workers', engine, 'reasoning'] as const
    if (typeof value === 'string') {
      const currentReasoning = document.getIn(path, true)
      if (isScalar(currentReasoning)) currentReasoning.value = value
      else document.setIn(path, value)
    } else {
      const currentReasoning = document.getIn(path, true)
      if (isScalar(currentReasoning)) document.deleteIn(path)
      for (const [rawTier, reasoning] of Object.entries(value)) {
        const tier = EffortSchema.parse(rawTier)
        document.setIn([...path, tier], reasoning)
      }
    }
  }

  const rendered = document.toString()
  PolicySchema.parse(parse(rendered) ?? {})
  return rendered
}

export async function writePolicyFile(repoRoot: string, patch: PolicyPatch): Promise<void> {
  const policyPath = join(repoRoot, 'policy.yaml')
  const examplePath = join(repoRoot, 'policy.example.yaml')

  // null → renderPolicyYaml seeds from DEFAULT_POLICY. A plugin install operates on the
  // user's project, which has no policy.example.yaml — only a dev clone seeds from it.
  let current: string | null
  try {
    current = await readFile(policyPath, 'utf8')
  } catch (error) {
    if (!isMissingFile(error)) throw readError(policyPath, error)
    try {
      current = await readFile(examplePath, 'utf8')
    } catch (exampleError) {
      if (!isMissingFile(exampleError)) throw readError(examplePath, exampleError)
      current = null
    }
  }

  const rendered = renderPolicyYaml(current, patch)
  try {
    await writeFile(policyPath, rendered, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to write ${policyPath}: ${detail}`)
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function readError(path: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`Failed to read ${path}: ${detail}`)
}
