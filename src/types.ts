import { z } from 'zod'

export const DelegateTaskShape = {
  objective: z
    .string()
    .min(1)
    .describe('What to implement — a bounded, well-specified change'),
  files: z
    .array(z.string())
    .optional()
    .describe('Repo-relative paths the task is expected to touch'),
  context: z
    .string()
    .optional()
    .describe('Constraints, conventions, or background the worker needs'),
  effort: z
    .enum(['light', 'standard', 'heavy'])
    .optional()
    .describe(
      'Engine-neutral difficulty hint that selects a worker model tier when configured; omit for the standard tier.',
    ),
  acceptance: z
    .array(z.string())
    .optional()
    .describe('Verifiable acceptance criteria the result must satisfy'),
  parent_job_id: z
    .string()
    .min(1)
    .optional()
    .describe('id of a rejected job this task revises'),
  feedback: z
    .string()
    .min(1)
    .optional()
    .describe('reviewer feedback on the parent attempt'),
  escalate: z
    .boolean()
    .optional()
    .describe('route away from the engine that produced the parent attempt'),
} as const

export const DelegateTaskSchema = z
  .object(DelegateTaskShape)
  .superRefine((task, context) => {
    if (task.feedback !== undefined && task.parent_job_id === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feedback'],
        message: 'feedback requires parent_job_id',
      })
    }
    if (task.escalate !== undefined && task.parent_job_id === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['escalate'],
        message: 'escalate requires parent_job_id',
      })
    }
  })

export type DelegateTask = z.infer<typeof DelegateTaskSchema>

export const GetDelegationResultSchema = z.object({
  job_id: z.string().min(1).describe('Job id returned by delegate_task'),
})

export type GetDelegationResultInput = z.infer<typeof GetDelegationResultSchema>

export type EngineName = 'codex' | 'claude'
export type Effort = 'light' | 'standard' | 'heavy'

// quota/auth are routing signals (skip the engine, try the next); other is a plain job failure.
export type FailureKind = 'quota' | 'auth' | 'other'

export interface WorkerOutcome {
  readonly exitCode: number
  readonly lastMessage: string | null
  readonly durationMs: number
  readonly failureKind?: FailureKind
  readonly retryAtMs?: number
}

// Shared shape between policy (zod schema output) and the quota ledger,
// so the two modules don't import each other.
export interface QuotaConfig {
  readonly maxJobsPer5h: number
  readonly maxJobsPerWeek: number
  readonly exhaustionCooldownMinutes: number
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface JobRecord {
  readonly jobId: string
  readonly status: JobStatus
  readonly objective: string
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly engine?: EngineName
  readonly result?: DelegateResult
  readonly error?: string
}

export interface JobSummary {
  readonly jobId: string
  readonly status: JobStatus
  readonly objective: string
  readonly createdAt: number
  readonly durationMs?: number
}

export interface JobPaths {
  readonly jobDir: string
  readonly promptFile: string
  readonly eventsFile: string
  readonly stderrFile: string
  readonly lastMessageFile: string
  readonly diffFile: string
  readonly statusFile: string
}

export interface WorktreeInfo {
  readonly path: string
  readonly branch: string
}

export interface DelegateResult {
  readonly jobId: string
  readonly branch: string
  readonly worktreePath: string
  readonly summary: string
  readonly diffPath: string
  readonly diff: string | null
  readonly exitCode: number
  readonly durationMs: number
  readonly engine: EngineName
}
