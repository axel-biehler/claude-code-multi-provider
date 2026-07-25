import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  buildDefaultWorkerRunner,
  cloneCommandFor,
  escalateEffortTier,
  executeJob,
  neutralizeRunnerErrors,
} from '../../src/jobs/executor'
import type { WorkerRunner } from '../../src/jobs/executor'
import { buildJobPaths } from '../../src/jobs/paths'
import { PolicySchema } from '../../src/routing/policy'
import { QuotaLedger } from '../../src/routing/quota'
import type { DelegateTask, EngineName } from '../../src/types'

const execFileAsync = promisify(execFile)

const TASK: DelegateTask = { objective: 'add a generated file' }

describe('executeJob', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-executor-'))
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
    await writeFile(join(repoRoot, '.gitignore'), 'node_modules\n.delegate\n', 'utf8')
    await writeFile(join(repoRoot, 'tracked.txt'), 'initial content\n', 'utf8')
    await execFileAsync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: repoRoot })
    await execFileAsync('git', ['-c', 'commit.gpgSign=false', 'commit', '-m', 'initial commit'], {
      cwd: repoRoot,
    })
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function listWorktreeDirs(): Promise<readonly string[]> {
    return readdir(join(repoRoot, '.delegate', 'worktrees')).catch((): string[] => [])
  }

  test('returns diff and summary from a successful run, records ok, and keeps the worktree', async () => {
    // Arrange
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    const runner: WorkerRunner = async (req) => {
      await writeFile(join(req.worktreePath, 'made-by-worker.txt'), 'hello from worker\n', 'utf8')
      return { exitCode: 0, lastMessage: 'did it', durationMs: 5 }
    }

    // Act
    const result = await executeJob({ repoRoot, policy, ledger, runWorker: runner }, 'job-ok', TASK)

    // Assert
    expect(result.jobId).toBe('job-ok')
    expect(result.summary).toBe('did it')
    expect(result.exitCode).toBe(0)
    expect(result.engine).toBe('codex')
    expect(result.diff).toContain('made-by-worker.txt')
    const snapshot = ledger.snapshot()
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.attempts[0]?.outcome).toBe('ok')
    const kept = await stat(result.worktreePath)
    expect(kept.isDirectory()).toBe(true)
  })

  test('passes the configured effort tier model to the selected worker', async () => {
    // Arrange
    const policy = PolicySchema.parse({
      chain: ['claude'],
      workers: { claude: { models: { heavy: 'tier-heavy' } } },
    })
    const ledger = await QuotaLedger.load(repoRoot)
    let model: string | undefined
    const runner: WorkerRunner = async (req) => {
      model = req.model
      return { exitCode: 0, lastMessage: 'done', durationMs: 1 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-heavy-model',
      { objective: 'add a generated file', effort: 'heavy' },
    )

    // Assert
    expect(model).toBe('tier-heavy')
  })

  test("passes the task's resolved effort tier reasoning to the selected worker", async () => {
    // Arrange
    const policy = PolicySchema.parse({
      chain: ['claude'],
      workers: { claude: { reasoning: { heavy: 'xhigh' } } },
    })
    const ledger = await QuotaLedger.load(repoRoot)
    let reasoning: string | undefined
    const runner: WorkerRunner = async (req) => {
      reasoning = req.reasoning
      return { exitCode: 0, lastMessage: 'done', durationMs: 1 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-heavy-reasoning',
      { objective: 'add a generated file', effort: 'heavy' },
    )

    // Assert
    expect(reasoning).toBe('xhigh')
  })

  test('dispatches kimi to the injected worker without reasoning', async () => {
    // Arrange
    const policy = PolicySchema.parse({
      chain: ['kimi'],
      workers: { kimi: { models: { heavy: 'kimi-heavy' } } },
    })
    const ledger = await QuotaLedger.load(repoRoot)
    const requests: Array<{ engine: EngineName; model?: string; reasoning?: string }> = []
    const runner: WorkerRunner = async (req) => {
      requests.push({ engine: req.engine, model: req.model, reasoning: req.reasoning })
      return { exitCode: 0, lastMessage: 'done', durationMs: 1 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-kimi-dispatch',
      { objective: 'add a generated file', effort: 'heavy' },
    )

    // Assert
    expect(requests).toEqual([
      { engine: 'kimi', model: 'kimi-heavy', reasoning: undefined },
    ])
  })

  test('escalates an implicit revision effort one tier above its parent', async () => {
    // Arrange
    const policy = PolicySchema.parse({
      chain: ['claude'],
      workers: {
        claude: {
          models: { heavy: 'tier-heavy' },
          reasoning: { heavy: 'xhigh' },
        },
      },
    })
    const ledger = await QuotaLedger.load(repoRoot)
    const parentDiffPath = join(repoRoot, 'blank-parent.patch')
    await writeFile(parentDiffPath, '', 'utf8')
    let selection: { model?: string; reasoning?: string } = {}
    const runner: WorkerRunner = async (req) => {
      selection = { model: req.model, reasoning: req.reasoning }
      return { exitCode: 0, lastMessage: 'done', durationMs: 1 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-revision-escalated-effort',
      TASK,
      { parentDiffPath, parentEffort: 'standard' },
    )

    // Assert
    expect(selection).toEqual({ model: 'tier-heavy', reasoning: 'xhigh' })
  })

  test('uses an explicit revision effort instead of escalating the parent effort', async () => {
    // Arrange
    const policy = PolicySchema.parse({
      chain: ['claude'],
      workers: {
        claude: {
          models: { light: 'tier-light', heavy: 'tier-heavy' },
          reasoning: { light: 'low', heavy: 'xhigh' },
        },
      },
    })
    const ledger = await QuotaLedger.load(repoRoot)
    const parentDiffPath = join(repoRoot, 'blank-parent.patch')
    await writeFile(parentDiffPath, '', 'utf8')
    let selection: { model?: string; reasoning?: string } = {}
    const runner: WorkerRunner = async (req) => {
      selection = { model: req.model, reasoning: req.reasoning }
      return { exitCode: 0, lastMessage: 'done', durationMs: 1 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-revision-explicit-effort',
      { ...TASK, effort: 'light' },
      { parentDiffPath, parentEffort: 'standard' },
    )

    // Assert
    expect(selection).toEqual({ model: 'tier-light', reasoning: 'low' })
  })

  test('resolves the fallback worker model after a quota reroute', async () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const policy = PolicySchema.parse({
      chain: ['codex', 'claude'],
      workers: { claude: { models: { standard: 'tier-standard' } } },
    })
    const ledger = await QuotaLedger.load(repoRoot)
    let fallbackModel: string | undefined
    const runner: WorkerRunner = async (req) => {
      if (req.engine === 'codex') {
        return { exitCode: 1, lastMessage: null, durationMs: 1, failureKind: 'quota' }
      }
      fallbackModel = req.model
      return { exitCode: 0, lastMessage: 'done', durationMs: 1 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-fallback-model',
      TASK,
    )

    // Assert
    expect(fallbackModel).toBe('tier-standard')
  })

  test('passes the scalar default model when no effort tiers are configured', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['claude'] })
    const ledger = await QuotaLedger.load(repoRoot)
    let model: string | undefined
    const runner: WorkerRunner = async (req) => {
      model = req.model
      return { exitCode: 0, lastMessage: 'done', durationMs: 1 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-default-model',
      TASK,
    )

    // Assert
    expect(model).toBe('sonnet')
  })

  test('provisions node_modules as a private clone so worker writes never reach shared deps', async () => {
    // Arrange — real dep content in the repo root; this repo runs on APFS (darwin),
    // so the clonefile path must be taken unconditionally, no symlink fallback.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    await mkdir(join(repoRoot, 'node_modules', 'some-pkg'), { recursive: true })
    await writeFile(join(repoRoot, 'node_modules', 'some-pkg', 'marker.txt'), 'dep marker\n', 'utf8')
    let worktreeDeps = ''
    const runner: WorkerRunner = async (req) => {
      worktreeDeps = join(req.worktreePath, 'node_modules')
      await writeFile(join(worktreeDeps, 'worker-write.txt'), 'lands in the clone only\n', 'utf8')
      return { exitCode: 0, lastMessage: 'ok', durationMs: 1 }
    }

    // Act
    await executeJob({ repoRoot, policy, ledger, runWorker: runner }, 'job-deps', TASK)

    // Assert — a REAL directory (not a symlink) carrying the cloned dep content
    const deps = await lstat(worktreeDeps)
    expect(deps.isDirectory()).toBe(true)
    expect(deps.isSymbolicLink()).toBe(false)
    const marker = await stat(join(worktreeDeps, 'some-pkg', 'marker.txt'))
    expect(marker.isFile()).toBe(true)
    // The M2 write-through is closed: the worker's write stays out of the shared deps.
    await expect(stat(join(repoRoot, 'node_modules', 'worker-write.txt'))).rejects.toThrow()
    expect(errorSpy).toHaveBeenCalledWith('[delegate] job deps: cloned')
  })

  test('falls back to the next engine when the first reports a quota failure', async () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const nowMs = Date.parse('2026-07-18T10:00:00Z')
    const ledger = await QuotaLedger.load(repoRoot, () => nowMs)
    const enginesSeen: EngineName[] = []
    const runner: WorkerRunner = async (req) => {
      enginesSeen.push(req.engine)
      if (req.engine === 'codex') {
        return { exitCode: 1, lastMessage: null, durationMs: 3, failureKind: 'quota' }
      }
      await writeFile(join(req.worktreePath, 'fallback.txt'), 'made by second engine\n', 'utf8')
      return { exitCode: 0, lastMessage: 'fallback did it', durationMs: 4 }
    }

    // Act
    const result = await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-fallback',
      TASK,
    )

    // Assert
    expect(enginesSeen).toEqual(['codex', 'claude'])
    expect(result.exitCode).toBe(0)
    expect(result.summary).toBe('fallback did it')
    expect(result.diff).toContain('fallback.txt')
    const snapshot = ledger.snapshot()
    expect(snapshot.attempts.map((attempt) => attempt.outcome)).toEqual(['quota', 'ok'])
    expect(snapshot.attempts[0]?.engine).toBe('codex')
    expect(snapshot.exhaustedUntil.codex).toBe(
      nowMs + policy.quotas.codex.exhaustionCooldownMinutes * 60_000,
    )
    await expect(listWorktreeDirs()).resolves.toHaveLength(1)
  })

  test('cools a quota-exhausted engine until the vendor retry timestamp and logs it', async () => {
    // Arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const nowMs = Date.parse('2026-07-18T10:00:00Z')
    const retryAtMs = Date.parse('2026-07-18T14:00:00Z')
    const ledger = await QuotaLedger.load(repoRoot, () => nowMs)
    const runner: WorkerRunner = async (req) => {
      if (req.engine === 'codex') {
        return {
          exitCode: 1,
          lastMessage: null,
          durationMs: 3,
          failureKind: 'quota',
          retryAtMs,
        }
      }
      return { exitCode: 0, lastMessage: 'fallback did it', durationMs: 4 }
    }

    // Act
    await executeJob({ repoRoot, policy, ledger, runWorker: runner }, 'job-vendor-reset', TASK)

    // Assert
    expect(ledger.snapshot().exhaustedUntil.codex).toBe(retryAtMs)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`cooldown until ${new Date(retryAtMs).toISOString()}`),
    )
  })

  test('rejects with the at-capacity message when every engine reports quota exhaustion', async () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot)
    const runner: WorkerRunner = async () => ({
      exitCode: 1,
      lastMessage: null,
      durationMs: 2,
      failureKind: 'quota',
    })

    // Act + Assert
    await expect(
      executeJob({ repoRoot, policy, ledger, runWorker: runner }, 'job-capacity', TASK),
    ).rejects.toThrow('All delegation engines are at capacity')

    await expect(listWorktreeDirs()).resolves.toHaveLength(0)
    const snapshot = ledger.snapshot()
    expect(snapshot.exhaustedUntil.codex).toBeDefined()
    expect(snapshot.exhaustedUntil.claude).toBeDefined()
  })

  test('resolves with the non-zero exit code and keeps the worktree on a plain failure', async () => {
    // Arrange
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    const runner: WorkerRunner = async () => ({
      exitCode: 1,
      lastMessage: 'tests failed',
      durationMs: 2,
      failureKind: 'other',
    })

    // Act
    const result = await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-other',
      TASK,
    )

    // Assert
    expect(result.exitCode).toBe(1)
    expect(result.summary).toBe('tests failed')
    const kept = await stat(result.worktreePath)
    expect(kept.isDirectory()).toBe(true)
    const snapshot = ledger.snapshot()
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.attempts[0]?.outcome).toBe('other')
  })

  test('cleans up the attempt worktree when the runner rejects with an infra error', async () => {
    // Arrange
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    const runner: WorkerRunner = async () => {
      throw new Error('worker process could not start')
    }

    // Act + Assert
    await expect(
      executeJob({ repoRoot, policy, ledger, runWorker: runner }, 'job-crash', TASK),
    ).rejects.toThrow('worker process could not start')

    await expect(listWorktreeDirs()).resolves.toHaveLength(0)
  })

  test('preserves the worktree and records quota when result collection fails after the worker ran', async () => {
    // Arrange — the runner does real work, then sabotages the worktree's .git link
    // so collectDiff fails: the completed edits must survive the bookkeeping failure.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    let workFile = ''
    const runner: WorkerRunner = async (req) => {
      workFile = join(req.worktreePath, 'completed-work.txt')
      await writeFile(workFile, 'valuable uncommitted work\n', 'utf8')
      await writeFile(join(req.worktreePath, '.git'), 'gitdir: /nonexistent\n', 'utf8')
      return { exitCode: 0, lastMessage: 'done', durationMs: 5 }
    }

    // Act + Assert
    await expect(
      executeJob({ repoRoot, policy, ledger, runWorker: runner }, 'job-preserve', TASK),
    ).rejects.toThrow(/Worktree preserved/)

    const survivor = await stat(workFile)
    expect(survivor.isFile()).toBe(true)
    const snapshot = ledger.snapshot()
    expect(snapshot.attempts).toHaveLength(1)
    expect(snapshot.attempts[0]?.outcome).toBe('ok')
  })

  test('applies a parent result diff before the revision runner starts', async () => {
    // Arrange
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    const parentRunner: WorkerRunner = async (req) => {
      await writeFile(join(req.worktreePath, 'tracked.txt'), 'parent revision content\n', 'utf8')
      return { exitCode: 0, lastMessage: 'parent done', durationMs: 2 }
    }
    const parent = await executeJob(
      { repoRoot, policy, ledger, runWorker: parentRunner },
      'job-parent',
      TASK,
    )
    let contentSeenByRunner = ''
    const revisionRunner: WorkerRunner = async (req) => {
      contentSeenByRunner = await readFile(join(req.worktreePath, 'tracked.txt'), 'utf8')
      return { exitCode: 0, lastMessage: 'revision done', durationMs: 2 }
    }

    // Act
    await executeJob(
      { repoRoot, policy, ledger, runWorker: revisionRunner },
      'job-revision',
      TASK,
      { parentDiffPath: parent.diffPath, feedback: 'Keep the parent change' },
    )

    // Assert
    expect(contentSeenByRunner).toBe('parent revision content\n')
  })

  test('excludes the parent engine from escalation routing', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot)
    const parentDiffPath = join(repoRoot, 'blank-parent.patch')
    await writeFile(parentDiffPath, '', 'utf8')
    const enginesSeen: EngineName[] = []
    const runner: WorkerRunner = async (req) => {
      enginesSeen.push(req.engine)
      return { exitCode: 0, lastMessage: 'escalated', durationMs: 2 }
    }

    // Act
    const result = await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-escalated',
      TASK,
      { parentDiffPath, excludeEngine: 'codex' },
    )

    // Assert
    expect(enginesSeen).toEqual(['claude'])
    expect(result.engine).toBe('claude')
  })

  test('rejects a non-applying parent diff with the documented message and cleans the worktree', async () => {
    // Arrange
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    const parentDiffPath = join(repoRoot, 'conflicting-parent.patch')
    await writeFile(parentDiffPath, 'this is not a valid diff\n', 'utf8')
    const runner = vi.fn<WorkerRunner>(async () => ({
      exitCode: 0,
      lastMessage: 'must not run',
      durationMs: 1,
    }))

    // Act + Assert
    await expect(
      executeJob(
        { repoRoot, policy, ledger, runWorker: runner },
        'job-conflict',
        TASK,
        { parentDiffPath },
      ),
    ).rejects.toThrow(
      'Parent diff no longer applies onto the current base (the main branch advanced since the parent job). Re-delegate without parent_job_id for a fresh attempt.',
    )
    expect(runner).not.toHaveBeenCalled()
    await expect(listWorktreeDirs()).resolves.toHaveLength(0)
  })

  test('skips git apply for a blank parent diff and still runs the worker', async () => {
    // Arrange
    const policy = PolicySchema.parse({})
    const ledger = await QuotaLedger.load(repoRoot)
    const parentDiffPath = join(repoRoot, 'blank-parent.patch')
    await writeFile(parentDiffPath, '  \n\t\n', 'utf8')
    const runner = vi.fn<WorkerRunner>(async () => ({
      exitCode: 0,
      lastMessage: 'blank diff accepted',
      durationMs: 1,
    }))

    // Act
    const result = await executeJob(
      { repoRoot, policy, ledger, runWorker: runner },
      'job-blank-parent',
      TASK,
      { parentDiffPath },
    )

    // Assert
    expect(runner).toHaveBeenCalledOnce()
    expect(result.summary).toBe('blank diff accepted')
  })

  test('reports a distinct error when escalation leaves no alternative engine', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex'] })
    const ledger = await QuotaLedger.load(repoRoot)
    const parentDiffPath = join(repoRoot, 'blank-parent.patch')
    await writeFile(parentDiffPath, '', 'utf8')

    // Act + Assert
    await expect(
      executeJob(
        { repoRoot, policy, ledger, runWorker: vi.fn() },
        'job-no-alternative',
        TASK,
        { parentDiffPath, excludeEngine: 'codex' },
      ),
    ).rejects.toThrow(
      'Escalation impossible: no alternative engine available. Re-delegate without escalate to allow the same engine.',
    )
    await expect(listWorktreeDirs()).resolves.toHaveLength(0)
  })
})

describe('escalateEffortTier', () => {
  test.each([
    ['light', 'standard'],
    ['standard', 'heavy'],
    ['heavy', 'heavy'],
    [undefined, 'heavy'],
  ] as const)('maps %s to %s', (parent, expected) => {
    // Act
    const effort = escalateEffortTier(parent)

    // Assert
    expect(effort).toBe(expected)
  })
})

describe('buildDefaultWorkerRunner', () => {
  test('runs antigravity with the user-local agy binary and configured options', async () => {
    // Arrange
    const repoRoot = await mkdtemp(join(tmpdir(), 'delegate-antigravity-runner-'))
    const fakeHome = join(repoRoot, 'home')
    const agyBin = join(fakeHome, '.local', 'bin', 'agy')
    const paths = buildJobPaths(repoRoot, 'job-antigravity-runner')
    const originalHome = process.env.HOME
    const originalPath = process.env.PATH
    await mkdir(join(fakeHome, '.local', 'bin'), { recursive: true })
    await mkdir(paths.jobDir, { recursive: true })
    await writeFile(
      agyBin,
      '#!/bin/sh\nprintf \'{"response":"%s","status":"success"}\' "$0|$*"\n',
      'utf8',
    )
    await chmod(agyBin, 0o755)
    process.env.HOME = fakeHome
    process.env.PATH = '/usr/bin:/bin'

    try {
      // Act
      const outcome = await buildDefaultWorkerRunner()({
        engine: 'antigravity',
        model: 'gemini-test',
        reasoning: 'high',
        repoRoot,
        worktreePath: repoRoot,
        prompt: 'Reply with exactly: ok',
        paths,
        policy: PolicySchema.parse({
          workers: { antigravity: { timeoutMs: 123_000 } },
        }),
      })

      // Assert
      expect(outcome.exitCode).toBe(0)
      expect(outcome.lastMessage).toContain(`${agyBin}|-p Reply with exactly: ok`)
      expect(outcome.lastMessage).toContain('--print-timeout 123s')
      expect(outcome.lastMessage).toContain('--model=gemini-test')
      expect(outcome.lastMessage).toContain('--effort=high')
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  test('runs kimi with the official user-local binary and no reasoning flags', async () => {
    // Arrange
    const repoRoot = await mkdtemp(join(tmpdir(), 'delegate-kimi-runner-'))
    const fakeHome = join(repoRoot, 'home')
    const kimiBin = join(fakeHome, '.kimi-code', 'bin', 'kimi')
    const paths = buildJobPaths(repoRoot, 'job-kimi-runner')
    const originalHome = process.env.HOME
    const originalPath = process.env.PATH
    await mkdir(join(fakeHome, '.kimi-code', 'bin'), { recursive: true })
    await mkdir(paths.jobDir, { recursive: true })
    await writeFile(
      kimiBin,
      '#!/bin/sh\nprintf \'{"role":"assistant","content":"%s"}\\n\' "$0|$*"\n',
      'utf8',
    )
    await chmod(kimiBin, 0o755)
    process.env.HOME = fakeHome
    process.env.PATH = '/usr/bin:/bin'

    try {
      // Act
      const outcome = await buildDefaultWorkerRunner()({
        engine: 'kimi',
        model: 'kimi-test',
        repoRoot,
        worktreePath: repoRoot,
        prompt: 'Reply with exactly: ok',
        paths,
        policy: PolicySchema.parse({
          workers: { kimi: { timeoutMs: 123_000 } },
        }),
      })

      // Assert
      expect(outcome.exitCode).toBe(0)
      expect(outcome.lastMessage).toContain(`${kimiBin}|-p Reply with exactly: ok`)
      expect(outcome.lastMessage).toContain('--add-dir')
      expect(outcome.lastMessage).toContain('--model=kimi-test')
      expect(outcome.lastMessage).not.toContain('--effort')
      expect(outcome.lastMessage).not.toContain('--yolo')
      expect(outcome.lastMessage).not.toContain('--auto')
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('neutralizeRunnerErrors', () => {
  test('replaces an engine-named spawn failure with an engine-neutral error', async () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const runner = neutralizeRunnerErrors(async () => {
      throw new Error('spawn agy ENOENT')
    })
    const request = {
      engine: 'antigravity' as const,
      repoRoot: '/tmp/none',
      worktreePath: '/tmp/none/wt',
      prompt: 'objective',
      paths: buildJobPaths('/tmp/none', 'job-neutral'),
      policy: PolicySchema.parse({}),
    }

    // Act
    const error = await runner(request).then(
      () => null,
      (rejection: unknown) => (rejection instanceof Error ? rejection : new Error(String(rejection))),
    )

    // Assert
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/failed to start or crashed/)
    expect(error?.message).not.toMatch(/codex/i)
    expect(error?.message).not.toMatch(/claude/i)
    expect(error?.message).not.toMatch(/antigravity|agy/i)
  })

  test('passes successful outcomes through untouched', async () => {
    // Arrange
    const outcome = { exitCode: 0, lastMessage: 'fine', durationMs: 1 }
    const runner = neutralizeRunnerErrors(async () => outcome)

    // Act
    const result = await runner({
      engine: 'claude',
      repoRoot: '/tmp/none',
      worktreePath: '/tmp/none/wt',
      prompt: 'objective',
      paths: buildJobPaths('/tmp/none', 'job-passthrough'),
      policy: PolicySchema.parse({}),
    })

    // Assert
    expect(result).toEqual(outcome)
  })
})

describe('cloneCommandFor', () => {
  test('uses APFS clonefile on macOS and reflink on Linux', () => {
    // Act + Assert
    expect(cloneCommandFor('darwin', '/repo/node_modules', '/wt/node_modules')).toEqual({
      command: 'cp',
      args: ['-c', '-R', '/repo/node_modules', '/wt/node_modules'],
    })
    expect(cloneCommandFor('linux', '/repo/node_modules', '/wt/node_modules')).toEqual({
      command: 'cp',
      args: ['-R', '--reflink=always', '/repo/node_modules', '/wt/node_modules'],
    })
  })

  test('returns null on Windows so provisioning goes straight to the junction symlink', () => {
    // Act + Assert
    expect(cloneCommandFor('win32', '/repo/node_modules', '/wt/node_modules')).toBeNull()
  })
})
