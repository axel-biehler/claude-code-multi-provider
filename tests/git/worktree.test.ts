import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { WorktreeInfo } from '../../src/types'
import { collectDiff, createWorktree, removeWorktree } from '../../src/git/worktree'

const execFileAsync = promisify(execFile)

describe('worktree', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-worktree-'))
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.email', 'test@test.local'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
    await execFileAsync('git', ['config', 'commit.gpgSign', 'false'], { cwd: repoRoot })
    await writeFile(join(repoRoot, 'tracked.txt'), 'initial content\n', 'utf8')
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoRoot })
    await execFileAsync('git', ['commit', '-m', 'initial commit'], { cwd: repoRoot })
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('createWorktree creates a worktree directory under .delegate/worktrees and a matching branch', async () => {
    // Arrange
    const jobId = 'job-123'

    // Act
    const info: WorktreeInfo = await createWorktree(repoRoot, jobId)

    // Assert
    expect(info.path).toBe(join(repoRoot, '.delegate', 'worktrees', jobId))
    expect(info.branch).toBe('delegate/job-123')

    const dirStat = await stat(info.path)
    expect(dirStat.isDirectory()).toBe(true)

    const { stdout } = await execFileAsync('git', ['branch', '--list', info.branch], { cwd: repoRoot })
    expect(stdout).toContain(info.branch)
  })

  test('collectDiff captures both modified tracked files and new untracked files', async () => {
    // Arrange
    const info = await createWorktree(repoRoot, 'job-456')
    await writeFile(join(info.path, 'tracked.txt'), 'modified content\n', 'utf8')
    await writeFile(join(info.path, 'new-file.txt'), 'brand new content\n', 'utf8')

    // Act
    const diff = await collectDiff(info.path)

    // Assert
    expect(diff).toContain('tracked.txt')
    expect(diff).toContain('modified content')
    expect(diff).toContain('new-file.txt')
    expect(diff).toContain('brand new content')
  })

  test('collectDiff does not stage file contents in the index', async () => {
    // Arrange
    const info = await createWorktree(repoRoot, 'job-stage-check')
    await writeFile(join(info.path, 'tracked.txt'), 'modified content\n', 'utf8')
    await writeFile(join(info.path, 'new-file.txt'), 'brand new content\n', 'utf8')

    // Act
    await collectDiff(info.path)
    const { stdout: cachedDiff } = await execFileAsync('git', ['diff', '--cached'], { cwd: info.path })

    // Assert
    expect(cachedDiff.trim()).toBe('')
  })

  test('collectDiff returns an empty-ish string when nothing has changed', async () => {
    // Arrange
    const info = await createWorktree(repoRoot, 'job-789')

    // Act
    const diff = await collectDiff(info.path)

    // Assert
    expect(diff.trim()).toBe('')
  })

  test('removeWorktree removes the worktree directory and deletes the branch when requested', async () => {
    // Arrange
    const info = await createWorktree(repoRoot, 'job-000')

    // Act
    await removeWorktree(repoRoot, info.path, info.branch, { deleteBranch: true })

    // Assert
    await expect(stat(info.path)).rejects.toThrow()
    const { stdout } = await execFileAsync('git', ['branch', '--list', info.branch], { cwd: repoRoot })
    expect(stdout.trim()).toBe('')
  })

  test('removeWorktree keeps the branch when deleteBranch is not requested', async () => {
    // Arrange
    const info = await createWorktree(repoRoot, 'job-keep-branch')

    // Act
    await removeWorktree(repoRoot, info.path, info.branch)

    // Assert
    await expect(stat(info.path)).rejects.toThrow()
    const { stdout } = await execFileAsync('git', ['branch', '--list', info.branch], { cwd: repoRoot })
    expect(stdout).toContain(info.branch)
  })
})
