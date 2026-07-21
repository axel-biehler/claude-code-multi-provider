import { mkdir, writeFile } from 'node:fs/promises'
import { buildJobPaths } from './paths'
import type { RevisionSpec } from './executor'
import type { Policy } from '../routing/policy'
import type { DelegateResult, DelegateTask, JobRecord, JobStatus, JobSummary } from '../types'

export function generateJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

export interface JobStoreDeps {
  readonly repoRoot: string
  readonly policy: Policy
  readonly execute: (
    jobId: string,
    task: DelegateTask,
    revision?: RevisionSpec,
  ) => Promise<DelegateResult>
  readonly now?: () => number
}

interface QueuedJob {
  readonly jobId: string
  readonly task: DelegateTask
  readonly revision?: RevisionSpec
}

/**
 * Session-scoped async job store: jobs die with the server by design. The in-memory
 * Map is the source of truth; status.json is a best-effort mirror so GC (and humans)
 * can read createdAt/finishedAt without the server.
 */
export class JobStore {
  private readonly repoRoot: string
  private readonly policy: Policy
  private readonly execute: (
    jobId: string,
    task: DelegateTask,
    revision?: RevisionSpec,
  ) => Promise<DelegateResult>
  private readonly now: () => number
  private readonly records = new Map<string, JobRecord>()
  private queue: readonly QueuedJob[] = []
  private runningCount = 0
  private mirrorChain: Promise<void> = Promise.resolve()

  constructor(deps: JobStoreDeps) {
    this.repoRoot = deps.repoRoot
    this.policy = deps.policy
    this.execute = deps.execute
    this.now = deps.now ?? Date.now
  }

  enqueue(
    task: DelegateTask,
    revision?: RevisionSpec,
  ): { readonly jobId: string; readonly status: JobStatus } {
    const jobId = generateJobId()
    const record: JobRecord = {
      jobId,
      status: 'queued',
      objective: task.objective,
      createdAt: this.now(),
    }
    this.records.set(jobId, record)
    this.mirrorStatus(record)
    this.queue = [...this.queue, { jobId, task, revision }]
    this.pump()

    // pump() may have promoted the job synchronously — report what actually happened.
    const current = this.records.get(jobId) ?? record
    return { jobId, status: current.status }
  }

  list(): readonly JobSummary[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => this.toSummary(record))
  }

  get(jobId: string): JobRecord | undefined {
    return this.records.get(jobId)
  }

  private pump(): void {
    while (this.runningCount < this.policy.maxConcurrentJobs && this.queue.length > 0) {
      const [next, ...remaining] = this.queue
      if (next === undefined) return
      this.queue = remaining
      this.runningCount += 1
      this.transition(next.jobId, (record) => ({
        ...record,
        status: 'running',
        startedAt: this.now(),
      }))
      // Fire-and-forget: runJob catches everything, so this promise can never reject.
      void this.runJob(next)
    }
  }

  private async runJob(job: QueuedJob): Promise<void> {
    try {
      const result = await this.execute(job.jobId, job.task, job.revision)
      // A failed run's diff is still reviewable — attach the result either way.
      this.transition(job.jobId, (record) => ({
        ...record,
        status: result.exitCode === 0 ? 'succeeded' : 'failed',
        engine: result.engine,
        result,
        finishedAt: this.now(),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.transition(job.jobId, (record) => ({
        ...record,
        status: 'failed',
        error: message,
        finishedAt: this.now(),
      }))
    } finally {
      this.runningCount -= 1
      this.logJobEnd(job.jobId)
      this.pump()
    }
  }

  private transition(jobId: string, apply: (record: JobRecord) => JobRecord): void {
    const current = this.records.get(jobId)
    if (!current) return
    const next = apply(current)
    this.records.set(jobId, next)
    this.mirrorStatus(next)
  }

  private toSummary(record: JobRecord): JobSummary {
    const durationMs =
      record.startedAt !== undefined
        ? (record.finishedAt ?? this.now()) - record.startedAt
        : undefined
    return {
      jobId: record.jobId,
      status: record.status,
      objective: record.objective,
      createdAt: record.createdAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
  }

  // Writes are chained so two rapid transitions can't interleave on the same file;
  // a mirror failure must never take a job (or the server) down.
  private mirrorStatus(record: JobRecord): void {
    this.mirrorChain = this.mirrorChain
      .then(() => this.writeStatusFile(record))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[delegate] failed to mirror status for job ${record.jobId}: ${message}`)
      })
  }

  private async writeStatusFile(record: JobRecord): Promise<void> {
    const paths = buildJobPaths(this.repoRoot, record.jobId)
    await mkdir(paths.jobDir, { recursive: true })
    // The diff already lives at diffPath — keep the mirror small by dropping it.
    const persisted = record.result
      ? { ...record, result: { ...record.result, diff: undefined } }
      : record
    await writeFile(paths.statusFile, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
  }

  private logJobEnd(jobId: string): void {
    const record = this.records.get(jobId)
    if (!record) return
    const durationMs =
      record.finishedAt !== undefined && record.startedAt !== undefined
        ? record.finishedAt - record.startedAt
        : 0
    console.error(`[delegate] job ${jobId} ${record.status} durationMs=${Math.round(durationMs)}`)
  }
}
