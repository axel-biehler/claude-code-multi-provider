import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { QuotaConfig } from '../types'

const POLICY_FILE_NAME = 'policy.yaml'

export const EngineNameSchema = z.enum(['codex', 'claude', 'antigravity'])
export const EffortSchema = z.enum(['light', 'standard', 'heavy'])
export const CodexReasoningSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh'])
export const ClaudeReasoningSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export const AntigravityReasoningSchema = z.enum(['low', 'medium', 'high'])

// Model ids are handed to the worker CLI as `--model=<id>`; reject a leading '-' so a
// crafted policy value can't be reinterpreted as a CLI flag (the adapters also use the
// single-token `--model=` form as the primary guard).
export const ModelIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('-'), { message: 'model id must not start with "-"' })

// Output must stay assignable to QuotaConfig (types.ts) so the quota ledger
// can consume parsed policy without importing this module.
const QuotaConfigSchema = z.object({
  maxJobsPer5h: z.number().int().min(1).default(10),
  maxJobsPerWeek: z.number().int().min(1).default(50),
  exhaustionCooldownMinutes: z.number().int().min(1).default(60),
})

export const PolicySchema = z.object({
  chain: z.array(EngineNameSchema).min(1).default(['codex', 'claude']),
  maxConcurrentJobs: z.number().int().min(1).max(8).default(2),
  workers: z
    .object({
      codex: z
        .object({
          model: ModelIdSchema.optional(),
          models: z.record(EffortSchema, ModelIdSchema).optional(),
          // A scalar applies to every tier; a map has no cross-tier fallback. Missing
          // reasoning means no CLI flag, preserving the engine's current default.
          reasoning: z
            .union([
              CodexReasoningSchema,
              z.record(EffortSchema, CodexReasoningSchema),
            ])
            .optional(),
          timeoutMs: z.number().int().positive().default(600_000),
        })
        .default({}),
      claude: z
        .object({
          model: ModelIdSchema.default('sonnet'),
          models: z.record(EffortSchema, ModelIdSchema).optional(),
          reasoning: z
            .union([
              ClaudeReasoningSchema,
              z.record(EffortSchema, ClaudeReasoningSchema),
            ])
            .optional(),
          maxBudgetUsd: z.number().positive().default(2),
          timeoutMs: z.number().int().positive().default(600_000),
        })
        .default({}),
      antigravity: z
        .object({
          model: ModelIdSchema.optional(),
          models: z.record(EffortSchema, ModelIdSchema).optional(),
          reasoning: z
            .union([
              AntigravityReasoningSchema,
              z.record(EffortSchema, AntigravityReasoningSchema),
            ])
            .optional(),
          timeoutMs: z.number().int().positive().default(600_000),
        })
        .default({}),
    })
    .default({}),
  quotas: z
    .object({
      codex: QuotaConfigSchema.default({}),
      claude: QuotaConfigSchema.default({}),
      antigravity: QuotaConfigSchema.default({}),
    })
    .default({}),
  retention: z
    .object({
      maxAgeDays: z.number().int().min(1).default(7),
      keepLast: z.number().int().min(0).default(10),
    })
    .default({}),
})

export type Policy = z.infer<typeof PolicySchema>

export const DEFAULT_POLICY: Policy = PolicySchema.parse({})

// Compile-time guard: breaks the build if the quota schema output ever drifts
// from the shared QuotaConfig interface.
DEFAULT_POLICY.quotas.codex satisfies QuotaConfig

/**
 * Loads `<repoRoot>/policy.yaml`. An absent file is the normal no-config case
 * and yields DEFAULT_POLICY; a malformed or invalid file throws so the user
 * knows their policy was NOT applied — never silently fall back.
 */
export async function loadPolicy(repoRoot: string): Promise<Policy> {
  const policyPath = join(repoRoot, POLICY_FILE_NAME)

  let raw: string
  try {
    raw = await readFile(policyPath, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return DEFAULT_POLICY
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read ${policyPath}: ${detail}`)
  }

  try {
    // yaml's parse returns null for an empty document — same as "no overrides".
    const document: unknown = parse(raw) ?? {}
    return PolicySchema.parse(document)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid policy in ${policyPath}: ${detail}`)
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
