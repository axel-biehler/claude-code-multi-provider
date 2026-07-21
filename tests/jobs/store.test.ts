import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { buildJobPaths } from '../../src/jobs/paths'
import { JobStore } from '../../src/jobs/store'
import { PolicySchema } from '../../src/routing/policy'
import type { DelegateResult, DelegateTask } from '../../src/types'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function buildResult(jobId: string, exitCode: number): DelegateResult {
  return {
    jobId,
    branch: `delegate/${jobId}`,
    worktreePath: `/fake/worktrees/${jobId}`,
    summary: 'fake summary',
    diffPath: `/fake/jobs/${jobId}/diff.patch`,
    diff: 'diff --git a/file.txt b/file.txt',
    exitCode,
    durationMs: 42,
    engine: 'codex',
  }
}

describe('JobStore', () => {
  let repoRoot: string
  let t: number
  const now = () => t

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-jobs-'))
    t = 1_000_000
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    // Retries absorb the race with still-running best-effort status mirrors
    // (fire-and-forget writes can land while rm walks the tree → ENOTEMPTY).
    await rm(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    vi.restoreAllMocks()
  })

  function createHarness(policyOverrides: Record<string, unknown> = {}) {
    const deferreds: Array<Deferred<DelegateResult>> = []
    const execute = (_jobId: string, _task: DelegateTask): Promise<DelegateResult> => {
      const deferred = createDeferred<DelegateResult>()
      deferreds.push(deferred)
      return deferred.promise
    }
    const store = new JobStore({
      repoRoot,
      policy: PolicySchema.parse(policyOverrides),
      execute,
      now,
    })
    return { store, deferreds }
  }

  test('enqueue returns a jobId and running status when a slot is free', () => {
    // Arrange
    const { store } = createHarness()

    // Act
    const { jobId, status } = store.enqueue({ objective: 'first task' })

    // Assert
    expect(jobId).toBeTruthy()
    expect(status).toBe('running')
    expect(store.get(jobId)?.startedAt).toBe(1_000_000)
  })

  test('honors maxConcurrentJobs and promotes the queued job when a slot frees up', async () => {
    // Arrange
    const { store, deferreds } = createHarness({ maxConcurrentJobs: 1 })
    const first = store.enqueue({ objective: 'first task' })
    const second = store.enqueue({ objective: 'second task' })
    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')

    // Act
    deferreds[0]?.resolve(buildResult(first.jobId, 0))

    // Assert
    await vi.waitFor(() => {
      expect(store.get(second.jobId)?.status).toBe('running')
    })
  })

  test('marks a zero-exit job succeeded with result, engine, finishedAt, and a diff-free status file', async () => {
    // Arrange
    const { store, deferreds } = createHarness()
    const { jobId } = store.enqueue({ objective: 'succeed' })
    t = 1_000_500

    // Act
    deferreds[0]?.resolve(buildResult(jobId, 0))

    // Assert
    await vi.waitFor(() => {
      expect(store.get(jobId)?.status).toBe('succeeded')
    })
    const record = store.get(jobId)
    expect(record?.result?.summary).toBe('fake summary')
    expect(record?.engine).toBe('codex')
    expect(record?.finishedAt).toBe(1_000_500)
    expect(store.list()[0]).not.toHaveProperty('engine')

    const statusFile = buildJobPaths(repoRoot, jobId).statusFile
    await vi.waitFor(async () => {
      const raw = await readFile(statusFile, 'utf8')
      const parsed = JSON.parse(raw) as { status?: string; result?: Record<string, unknown> }
      expect(parsed.status).toBe('succeeded')
      expect(parsed.result).toBeDefined()
      expect(parsed.result?.diff).toBeUndefined()
    })
  })

  test('marks the job failed with the error message when execute rejects', async () => {
    // Arrange
    const { store, deferreds } = createHarness()
    const { jobId } = store.enqueue({ objective: 'explode' })

    // Act
    deferreds[0]?.reject(new Error('worker infrastructure failed'))

    // Assert
    await vi.waitFor(() => {
      expect(store.get(jobId)?.status).toBe('failed')
    })
    expect(store.get(jobId)?.error).toBe('worker infrastructure failed')
    expect(store.get(jobId)?.result).toBeUndefined()
  })

  test('marks a non-zero exit failed but still attaches the result for review', async () => {
    // Arrange
    const { store, deferreds } = createHarness()
    const { jobId } = store.enqueue({ objective: 'fail with diff' })

    // Act
    deferreds[0]?.resolve(buildResult(jobId, 1))

    // Assert
    await vi.waitFor(() => {
      expect(store.get(jobId)?.status).toBe('failed')
    })
    expect(store.get(jobId)?.result?.exitCode).toBe(1)
    expect(store.get(jobId)?.result?.diff).toContain('file.txt')
  })

  test('list returns newest first and computes durationMs for running jobs', () => {
    // Arrange
    const { store } = createHarness()
    const first = store.enqueue({ objective: 'older job' })
    t += 1_000
    const second = store.enqueue({ objective: 'newer job' })

    // Act
    t += 500
    const summaries = store.list()

    // Assert
    expect(summaries.map((summary) => summary.jobId)).toEqual([second.jobId, first.jobId])
    expect(summaries[0]?.durationMs).toBe(500)
    expect(summaries[1]?.durationMs).toBe(1_500)
    expect(summaries.every((summary) => !('engine' in summary))).toBe(true)
  })

  test('get returns undefined for an unknown job id', () => {
    // Arrange
    const { store } = createHarness()

    // Act
    const record = store.get('nope-0000')

    // Assert
    expect(record).toBeUndefined()
  })
})
