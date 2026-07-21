import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeInfo } from '../types'

const execFileAsync = promisify(execFile)

interface RemoveWorktreeOptions {
  readonly deleteBranch?: boolean
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd })
    return stdout
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${detail}`)
  }
}

/**
 * Creates an isolated git worktree + branch for a delegated job, based on HEAD.
 * `git worktree add` creates any missing parent directories itself.
 */
export async function createWorktree(repoRoot: string, jobId: string): Promise<WorktreeInfo> {
  const path = join(repoRoot, '.delegate', 'worktrees', jobId)
  const branch = `delegate/${jobId}`

  await runGit(repoRoot, ['worktree', 'add', path, '-b', branch])

  return { path, branch }
}

/**
 * `-N` (intent-to-add) records untracked files in the index with no content,
 * so the plain (unstaged) `git diff` below reports them as additions too —
 * without actually staging any file contents.
 */
export async function collectDiff(worktreePath: string): Promise<string> {
  await runGit(worktreePath, ['add', '-A', '-N'])
  return runGit(worktreePath, ['diff'])
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  opts?: RemoveWorktreeOptions
): Promise<void> {
  await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath])

  if (!opts?.deleteBranch) return

  await runGit(repoRoot, ['branch', '-D', branch])
}
