import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { planGc, runGc } from '../../src/git/gc'
import { createWorktree } from '../../src/git/worktree'

const execFileAsync = promisify(execFile)

const MS_PER_DAY = 86_400_000
const RETENTION_DEFAULT = { maxAgeDays: 7, keepLast: 10 }
const RETENTION_NO_KEEP = { maxAgeDays: 7, keepLast: 0 }

describe('gc', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-gc-'))
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
    await writeFile(join(repoRoot, 'tracked.txt'), 'initial content\n', 'utf8')
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot })
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  async function writeJobStatus(jobId: string, finishedAt: number, status?: string): Promise<void> {
    const jobDir = join(repoRoot, '.delegate', 'jobs', jobId)
    await mkdir(jobDir, { recursive: true })
    const payload = status === undefined ? { finishedAt } : { finishedAt, status }
    await writeFile(join(jobDir, 'status.json'), JSON.stringify(payload), 'utf8')
  }

  async function commitAndMergeWorktree(worktreePath: string, branch: string): Promise<void> {
    await writeFile(join(worktreePath, 'feature.txt'), 'feature\n', 'utf8')
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: worktreePath })
    await execFileAsync('git', ['commit', '-m', 'feature'], { cwd: worktreePath })
    await execFileAsync('git', ['merge', branch, '-m', 'merge delegated work'], { cwd: repoRoot })
  }

  test('plans a merged clean worktree as merged when the job is recorded succeeded', async () => {
    // Arrange
    const now = Date.now()
    const info = await createWorktree(repoRoot, 'job-merged')
    await commitAndMergeWorktree(info.path, info.branch)
    await writeJobStatus('job-merged', now, 'succeeded')

    // Act
    const plan = await planGc({ repoRoot, retention: RETENTION_DEFAULT, now: () => now })

    // Assert
    expect(plan).toEqual([
      {
        jobId: 'job-merged',
        worktreePath: info.path,
        branch: 'delegate/job-merged',
        reason: 'merged',
      },
    ])
  })

  test('plans a succeeded no-op worktree as merged debris', async () => {
    // Arrange
    const now = Date.now()
    const info = await createWorktree(repoRoot, 'job-debris')
    await writeJobStatus('job-debris', now, 'succeeded')

    // Act
    const plan = await planGc({ repoRoot, retention: RETENTION_DEFAULT, now: () => now })

    // Assert
    expect(plan).toHaveLength(1)
    expect(plan[0]?.jobId).toBe('job-debris')
    expect(plan[0]?.reason).toBe('merged')
    expect(plan[0]?.branch).toBe(info.branch)
  })

  test('never plans a clean never-diverged worktree whose job is not recorded succeeded', async () => {
    // Arrange — a job that crashed at start: clean worktree, branch at HEAD, status failed.
    // Its artifacts may still be uninspected; only the stale rule may ever remove it.
    const now = Date.now()
    await createWorktree(repoRoot, 'job-crashed')
    await writeJobStatus('job-crashed', now, 'failed')
    await createWorktree(repoRoot, 'job-no-status')

    // Act
    const plan = await planGc({ repoRoot, retention: RETENTION_DEFAULT, now: () => now })

    // Assert
    expect(plan).toEqual([])
  })

  test('never plans a recent dirty worktree even though its branch is an ancestor of HEAD', async () => {
    // Arrange
    const info = await createWorktree(repoRoot, 'job-pending-review')
    await writeFile(join(info.path, 'wip.txt'), 'uncommitted work\n', 'utf8')
    const now = Date.now()

    // Act
    const plan = await planGc({ repoRoot, retention: RETENTION_DEFAULT, now: () => now })

    // Assert
    expect(plan).toEqual([])
  })

  test('plans an old dirty worktree beyond maxAgeDays as stale when keepLast is 0', async () => {
    // Arrange
    const info = await createWorktree(repoRoot, 'job-old-dirty')
    await writeFile(join(info.path, 'wip.txt'), 'abandoned work\n', 'utf8')
    const now = Date.now()
    await writeJobStatus('job-old-dirty', now - 30 * MS_PER_DAY)

    // Act
    const plan = await planGc({ repoRoot, retention: RETENTION_NO_KEEP, now: () => now })

    // Assert
    expect(plan).toHaveLength(1)
    expect(plan[0]?.jobId).toBe('job-old-dirty')
    expect(plan[0]?.reason).toBe('stale')
    expect(plan[0]?.worktreePath).toBe(info.path)
  })

  test('keepLast protects the newest job from stale so only the older one is planned', async () => {
    // Arrange
    const now = Date.now()
    await writeJobStatus('job-older', now - 30 * MS_PER_DAY)
    await writeJobStatus('job-newer', now - 20 * MS_PER_DAY)

    // Act
    const plan = await planGc({ repoRoot, retention: { maxAgeDays: 7, keepLast: 1 }, now: () => now })

    // Assert
    expect(plan).toHaveLength(1)
    expect(plan[0]?.jobId).toBe('job-older')
    expect(plan[0]?.reason).toBe('stale')
  })

  test('plans an old artifacts-only jobs dir as stale and leaves a recent one alone', async () => {
    // Arrange
    const now = Date.now()
    await writeJobStatus('job-old-artifacts', now - 10 * MS_PER_DAY)
    await writeJobStatus('job-recent-artifacts', now - 1 * MS_PER_DAY)

    // Act
    const plan = await planGc({ repoRoot, retention: RETENTION_NO_KEEP, now: () => now })

    // Assert
    expect(plan).toEqual([
      {
        jobId: 'job-old-artifacts',
        worktreePath: null,
        branch: null,
        reason: 'stale',
      },
    ])
  })

  test('runGc removes worktree, branch and jobs dir for a merged candidate while a pending job survives intact', async () => {
    // Arrange
    const merged = await createWorktree(repoRoot, 'job-done')
    await commitAndMergeWorktree(merged.path, merged.branch)
    await writeJobStatus('job-done', Date.now(), 'succeeded')

    const pending = await createWorktree(repoRoot, 'job-pending')
    await writeFile(join(pending.path, 'wip.txt'), 'uncommitted work\n', 'utf8')
    await writeJobStatus('job-pending', Date.now())

    const now = Date.now()
    const opts = { repoRoot, retention: RETENTION_DEFAULT, now: () => now }
    const plan = await planGc(opts)
    expect(plan).toHaveLength(1)
    expect(plan[0]?.jobId).toBe('job-done')

    // Act
    const report = await runGc(opts, plan)

    // Assert
    expect(report.failed).toEqual([])
    expect(report.removed).toHaveLength(1)

    await expect(stat(merged.path)).rejects.toThrow()
    const { stdout: mergedBranch } = await execFileAsync('git', ['branch', '--list', merged.branch], { cwd: repoRoot })
    expect(mergedBranch.trim()).toBe('')
    await expect(stat(join(repoRoot, '.delegate', 'jobs', 'job-done'))).rejects.toThrow()

    const pendingWip = await stat(join(pending.path, 'wip.txt'))
    expect(pendingWip.isFile()).toBe(true)
    const { stdout: pendingBranch } = await execFileAsync('git', ['branch', '--list', pending.branch], { cwd: repoRoot })
    expect(pendingBranch).toContain(pending.branch)
    const pendingJobDir = await stat(join(repoRoot, '.delegate', 'jobs', 'job-pending'))
    expect(pendingJobDir.isDirectory()).toBe(true)
  })

  test('planGc returns an empty plan when .delegate does not exist', async () => {
    // Arrange — fresh repo, no .delegate dir at all

    // Act
    const plan = await planGc({ repoRoot, retention: RETENTION_DEFAULT })

    // Assert
    expect(plan).toEqual([])
  })
})
