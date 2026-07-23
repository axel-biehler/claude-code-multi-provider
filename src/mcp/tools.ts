import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { detectAuthenticatedProviders } from '../config/detect'
import type { ProviderDetection } from '../config/detect'
import { listAllProviderModels } from '../config/models'
import type { ModelOption, ProviderModels } from '../config/models'
import { writePolicyFile } from '../config/policy-writer'
import type { RevisionSpec } from '../jobs/executor'
import type { JobStore } from '../jobs/store'
import { EffortSchema, EngineNameSchema, ModelIdSchema, loadPolicy } from '../routing/policy'
import type { Policy } from '../routing/policy'
import { DelegateTaskSchema, DelegateTaskShape, GetDelegationResultSchema } from '../types'
import type { DelegateResult, DelegateTask, Effort, EngineName, JobRecord } from '../types'

const DIFF_INLINE_LIMIT_CHARS = 4000

interface ServerInfo {
  readonly bootedAt: number
  readonly gitRev: string
}

interface CheckDelegationJob {
  readonly job_id: string
  readonly status: string
  readonly objective: string
  readonly durationMs?: number
}

const ModelsValueSchema = z.union([ModelIdSchema, z.record(EffortSchema, ModelIdSchema)])

const ConfigureDelegationInputShape = {
  action: z.enum(['detect', 'write']),
  chain: z.array(EngineNameSchema).optional(),
  models: z.record(EngineNameSchema, ModelsValueSchema).optional(),
}

const ConfigureDelegationInputSchema = z.object(ConfigureDelegationInputShape)

const ConfigureDelegationWriteInputSchema = z.object({
  action: z.literal('write'),
  chain: z.array(EngineNameSchema).min(1),
  models: z.record(EngineNameSchema, ModelsValueSchema).default({}),
})

type PolicySummary = {
  readonly chain: readonly EngineName[]
  readonly models: Partial<Record<EngineName, string>>
  readonly modelTiers?: Partial<Record<EngineName, Partial<Record<Effort, string>>>>
}

type ConfigureDelegationWriteInput = z.infer<typeof ConfigureDelegationWriteInputSchema>

type ProviderDetectPayload = {
  readonly available: boolean
  readonly detail: string
  readonly models: readonly ModelOption[]
  readonly modelsSource: ProviderModels['source']
  readonly defaultModel?: string
}

export function buildCheckDelegationsPayload(
  serverInfo: ServerInfo,
  jobs: readonly CheckDelegationJob[],
): { readonly server: ServerInfo; readonly jobs: readonly CheckDelegationJob[] } {
  return { server: serverInfo, jobs }
}

function summarizePolicy(policy: Policy): PolicySummary {
  const models: Partial<Record<EngineName, string>> = {}
  if (policy.workers.codex.model !== undefined) models.codex = policy.workers.codex.model
  if (policy.workers.claude.model !== undefined) models.claude = policy.workers.claude.model
  if (policy.workers.antigravity.model !== undefined) {
    models.antigravity = policy.workers.antigravity.model
  }
  const modelTiers: Partial<Record<EngineName, Partial<Record<Effort, string>>>> = {}
  if (policy.workers.codex.models !== undefined) modelTiers.codex = policy.workers.codex.models
  if (policy.workers.claude.models !== undefined) modelTiers.claude = policy.workers.claude.models
  if (policy.workers.antigravity.models !== undefined) {
    modelTiers.antigravity = policy.workers.antigravity.models
  }
  return {
    chain: policy.chain,
    models,
    ...(Object.keys(modelTiers).length > 0 ? { modelTiers } : {}),
  }
}

export function buildConfigureDelegationDetectPayload(
  providers: Record<EngineName, ProviderDetection>,
  models: Record<EngineName, ProviderModels>,
  currentPolicy: Policy | null,
): {
  readonly providers: Record<EngineName, ProviderDetectPayload>
  readonly currentPolicy: PolicySummary | null
} {
  return {
    providers: {
      codex: {
        available: providers.codex.available,
        detail: providers.codex.detail,
        models: models.codex.models,
        modelsSource: models.codex.source,
        ...(models.codex.defaultModel === undefined
          ? {}
          : { defaultModel: models.codex.defaultModel }),
      },
      claude: {
        available: providers.claude.available,
        detail: providers.claude.detail,
        models: models.claude.models,
        modelsSource: models.claude.source,
        ...(models.claude.defaultModel === undefined
          ? {}
          : { defaultModel: models.claude.defaultModel }),
      },
      antigravity: {
        available: providers.antigravity.available,
        detail: providers.antigravity.detail,
        models: models.antigravity.models,
        modelsSource: models.antigravity.source,
        ...(models.antigravity.defaultModel === undefined
          ? {}
          : { defaultModel: models.antigravity.defaultModel }),
      },
    },
    currentPolicy: currentPolicy === null ? null : summarizePolicy(currentPolicy),
  }
}

export function parseConfigureDelegationWriteInput(
  input: unknown,
): ConfigureDelegationWriteInput {
  return ConfigureDelegationWriteInputSchema.parse(input)
}

async function loadExistingPolicy(repoRoot: string): Promise<Policy | null> {
  const policyPath = join(repoRoot, 'policy.yaml')
  try {
    await access(policyPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to access ${policyPath}: ${detail}`)
  }
  return loadPolicy(repoRoot)
}

export async function writeDelegationPolicy(
  repoRoot: string,
  input: unknown,
): Promise<PolicySummary> {
  const { chain, models } = parseConfigureDelegationWriteInput(input)
  await writePolicyFile(repoRoot, { chain, models })
  return summarizePolicy(await loadPolicy(repoRoot))
}

const DELEGATE_TASK_DESCRIPTION =
  'Delegate a bounded, well-specified implementation subtask to an isolated worker. Use for well-scoped implementation/tests/refactor tasks; keep architecture and validation yourself. An optional effort hint (light | standard | heavy) selects the worker model tier when configured. Returns immediately with a job_id while the worker runs in an isolated git worktree in the background. Poll check_delegations for progress; fetch the outcome with get_delegation_result. To revise a rejected attempt, set parent_job_id to its session-scoped job id and optionally set feedback to the reviewer feedback; set escalate=true to route away from the engine that produced the parent attempt.'

const CHECK_DELEGATIONS_DESCRIPTION =
  'List all delegated jobs in this session with their status (queued | running | succeeded | failed). Read-only, instant.'

const GET_DELEGATION_RESULT_DESCRIPTION =
  'Fetch the outcome of a delegated job by job_id. While queued/running returns the status; once finished returns the distilled summary + diff for review.'

const CONFIGURE_DELEGATION_DESCRIPTION =
  'Inspect delegation worker availability and locally discovered models for each provider (newest first) alongside current routing settings, or update the ordered routing chain and worker model selections. Detection performs local checks only and does not run a worker.'

function formatDiffSection(diff: string | null, diffPath: string): string {
  const diffText = diff ?? ''
  if (diffText.length >= DIFF_INLINE_LIMIT_CHARS) {
    return `## Diff\nThe diff is large — read it at ${diffPath}.`
  }
  return `## Diff\n\`\`\`diff\n${diffText}\n\`\`\``
}

function formatResult(result: DelegateResult): string {
  const meta = [
    `- Branch: \`${result.branch}\``,
    `- Worktree: \`${result.worktreePath}\``,
    `- Diff file: \`${result.diffPath}\``,
    `- Exit code: ${result.exitCode}`,
    `- Duration: ${Math.round(result.durationMs)}ms`,
  ].join('\n')

  return `## Summary\n${result.summary}\n\n${meta}\n\n${formatDiffSection(result.diff, result.diffPath)}`
}

function textResult(text: string, isError: boolean): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  }
}

type RevisionResolution =
  | { readonly revision: RevisionSpec | undefined; readonly error?: never }
  | { readonly revision?: never; readonly error: string }

export function resolveRevision(
  parent: JobRecord | undefined,
  input: DelegateTask,
): RevisionResolution {
  if (input.parent_job_id === undefined) return { revision: undefined }
  if (parent === undefined) {
    return {
      error: `Unknown parent job id ${input.parent_job_id}; jobs are session-scoped.`,
    }
  }
  if (parent.status === 'queued' || parent.status === 'running') {
    return {
      error: `Parent job ${input.parent_job_id} is still ${parent.status}; wait for it to finish before revising it.`,
    }
  }
  if (parent.result === undefined) {
    return {
      error: `Parent job ${input.parent_job_id} has no result; an infrastructure failure left no diff to revise.`,
    }
  }
  return {
    revision: {
      parentDiffPath: parent.result.diffPath,
      feedback: input.feedback,
      excludeEngine: input.escalate === true ? parent.engine : undefined,
    },
  }
}

export function registerDelegateTools(
  server: McpServer,
  store: JobStore,
  serverInfo: ServerInfo,
  repoRoot: string,
): void {
  server.registerTool(
    'delegate_task',
    {
      description: DELEGATE_TASK_DESCRIPTION,
      inputSchema: DelegateTaskShape,
    },
    async (input) => {
      const task = DelegateTaskSchema.parse(input)
      const parent =
        task.parent_job_id === undefined ? undefined : store.get(task.parent_job_id)
      const resolution = resolveRevision(parent, task)
      if (resolution.error !== undefined) return textResult(resolution.error, true)
      const { jobId, status } = store.enqueue(task, resolution.revision)
      return textResult(JSON.stringify({ job_id: jobId, status }), false)
    },
  )

  server.registerTool(
    'check_delegations',
    {
      description: CHECK_DELEGATIONS_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // jobId → job_id so the listing matches get_delegation_result's input surface.
      const jobs = store.list().map((job) => ({
        job_id: job.jobId,
        status: job.status,
        objective: job.objective,
        durationMs: job.durationMs,
      }))
      return textResult(JSON.stringify(buildCheckDelegationsPayload(serverInfo, jobs)), false)
    },
  )

  server.registerTool(
    'get_delegation_result',
    {
      description: GET_DELEGATION_RESULT_DESCRIPTION,
      inputSchema: GetDelegationResultSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const { job_id } = GetDelegationResultSchema.parse(input)
      const record = store.get(job_id)
      if (record === undefined) {
        return textResult(`Unknown job id: ${job_id}`, true)
      }
      if (record.status === 'queued' || record.status === 'running') {
        return textResult(JSON.stringify({ job_id, status: record.status }), false)
      }
      // A failed run with a result attached still carries a reviewable diff.
      if (record.result !== undefined) {
        return textResult(formatResult(record.result), record.status === 'failed')
      }
      return textResult(`Delegated worker failed: ${record.error ?? 'unknown error'}`, true)
    },
  )

  server.registerTool(
    'configure_delegation',
    {
      description: CONFIGURE_DELEGATION_DESCRIPTION,
      inputSchema: ConfigureDelegationInputShape,
    },
    async (input) => {
      try {
        const parsed = ConfigureDelegationInputSchema.parse(input)
        if (parsed.action === 'detect') {
          const [providers, models, currentPolicy] = await Promise.all([
            detectAuthenticatedProviders(repoRoot),
            listAllProviderModels(repoRoot),
            loadExistingPolicy(repoRoot),
          ])
          return textResult(
            JSON.stringify(
              buildConfigureDelegationDetectPayload(providers, models, currentPolicy),
            ),
            false,
          )
        }
        return textResult(JSON.stringify(await writeDelegationPolicy(repoRoot, parsed)), false)
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true)
      }
    },
  )
}
