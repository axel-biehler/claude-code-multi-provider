import { execFile } from 'node:child_process'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Policy } from '../routing/policy'
import { removeWorktree } from './worktree'

const execFileAsync = promisify(execFile)

const MS_PER_DAY = 86_400_000

export interface GcCandidate {
  readonly jobId: string
  readonly worktreePath: string | null
  readonly branch: string | null
  readonly reason: 'merged' | 'stale'
}

export interface GcReport {
  readonly removed: readonly GcCandidate[]
  readonly failed: ReadonlyArray<{ readonly candidate: GcCandidate; readonly error: string }>
}

export interface GcOptions {
  readonly repoRoot: string
  readonly retention: Policy['retention']
  readonly now?: () => number
}

interface DiscoveredJob {
  readonly jobId: string
  readonly worktreePath: string | null
  readonly branch: string | null
  readonly ageTimestamp: number
  readonly jobStatus: string | null
}

/**
 * Plans which delegated-job leftovers are safe to remove.
 *
 * 'merged' needs a job recorded as succeeded, whose branch is an ancestor of HEAD,
 * with a clean worktree. The clean check guards pending reviews (an unreviewed job's
 * branch also sits at HEAD-at-creation — the worker leaves changes uncommitted); the
 * succeeded check keeps ancestor+clean from sweeping jobs that merely never diverged
 * (crashed-at-start or freshly failed jobs whose artifacts are still uninspected).
 *
 * 'stale' means older than retention.maxAgeDays and not among the keepLast
 * newest jobs. keepLast shields from 'stale' only — merged debris goes regardless.
 */
export async function planGc(opts: GcOptions): Promise<readonly GcCandidate[]> {
  const nowMs = (opts.now ?? Date.now)()
  const jobs = await discoverJobs(opts.repoRoot, nowMs)
  const maxAgeMs = opts.retention.maxAgeDays * MS_PER_DAY

  const protectedIds = new Set(
    [...jobs]
      .sort((a, b) => b.ageTimestamp - a.ageTimestamp)
      .slice(0, opts.retention.keepLast)
      .map((job) => job.jobId),
  )

  const classified = await Promise.all(
    jobs.map((job) => classifyJob(opts.repoRoot, job, nowMs, maxAgeMs, protectedIds)),
  )
  return classified.filter((candidate): candidate is GcCandidate => candidate !== null)
}

export async function runGc(opts: GcOptions, plan: readonly GcCandidate[]): Promise<GcReport> {
  const removed: GcCandidate[] = []
  const failed: Array<{ readonly candidate: GcCandidate; readonly error: string }> = []

  // Sequential on purpose: worktree removals mutate shared git state.
  for (const candidate of plan) {
    try {
      await removeCandidate(opts.repoRoot, candidate)
      removed.push(candidate)
    } catch (error) {
      failed.push({ candidate, error: errorMessage(error) })
    }
  }

  return { removed, failed }
}

async function classifyJob(
  repoRoot: string,
  job: DiscoveredJob,
  nowMs: number,
  maxAgeMs: number,
  protectedIds: ReadonlySet<string>,
): Promise<GcCandidate | null> {
  if (job.worktreePath !== null && job.branch !== null && job.jobStatus === 'succeeded') {
    const merged = await isMergedAndClean(repoRoot, job.worktreePath, job.branch)
    if (merged) {
      return { jobId: job.jobId, worktreePath: job.worktreePath, branch: job.branch, reason: 'merged' }
    }
  }

  const isStale = nowMs - job.ageTimestamp > maxAgeMs && !protectedIds.has(job.jobId)
  if (isStale) {
    return { jobId: job.jobId, worktreePath: job.worktreePath, branch: job.branch, reason: 'stale' }
  }

  return null
}

async function discoverJobs(repoRoot: string, nowMs: number): Promise<readonly DiscoveredJob[]> {
  const worktreesRoot = join(repoRoot, '.delegate', 'worktrees')
  const jobsRoot = join(repoRoot, '.delegate', 'jobs')
  const [worktreeIds, jobIds] = await Promise.all([listDirs(worktreesRoot), listDirs(jobsRoot)])

  const worktreeSet = new Set(worktreeIds)
  const allIds = [...new Set([...worktreeIds, ...jobIds])].sort()

  return Promise.all(
    allIds.map(async (jobId) => {
      const worktreePath = worktreeSet.has(jobId) ? join(worktreesRoot, jobId) : null
      const branchName = `delegate/${jobId}`
      const hasBranch = worktreePath !== null && (await branchExists(repoRoot, branchName))
      const jobDir = join(jobsRoot, jobId)
      const statusInfo = await readStatusFile(join(jobDir, 'status.json'))
      const ageTimestamp =
        statusInfo.timestamp ??
        (await dirMtimeMs(worktreePath)) ??
        (await dirMtimeMs(jobDir)) ??
        // No readable timestamp at all → treat as brand new so it can never go stale by accident.
        nowMs
      return {
        jobId,
        worktreePath,
        branch: hasBranch ? branchName : null,
        ageTimestamp,
        jobStatus: statusInfo.status,
      }
    }),
  )
}

async function removeCandidate(repoRoot: string, candidate: GcCandidate): Promise<void> {
  if (candidate.worktreePath !== null) {
    // A null branch means it is already gone — remove the dir, skip branch deletion.
    await removeWorktree(repoRoot, candidate.worktreePath, candidate.branch ?? '', {
      deleteBranch: candidate.branch !== null,
    })
  }
  await rm(join(repoRoot, '.delegate', 'jobs', candidate.jobId), { recursive: true, force: true })
}

async function isMergedAndClean(repoRoot: string, worktreePath: string, branch: string): Promise<boolean> {
  const isAncestor = await gitSucceeds(repoRoot, ['merge-base', '--is-ancestor', branch, 'HEAD'])
  if (!isAncestor) return false
  return isWorktreeClean(worktreePath)
}

async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath })
    return stdout.trim() === ''
  } catch (error) {
    // Unreadable worktree state reads as dirty — never risk a pending review.
    console.error(`gc: git status failed in ${worktreePath}: ${errorMessage(error)}`)
    return false
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  return gitSucceeds(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
}

// Boolean probe: any failure (non-zero exit, git missing) reads as "no",
// which is the conservative direction for every caller.
async function gitSucceeds(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd })
    return true
  } catch {
    return false
  }
}

interface StatusFileInfo {
  readonly timestamp: number | null
  readonly status: string | null
}

const EMPTY_STATUS_INFO: StatusFileInfo = { timestamp: null, status: null }

// Lenient by design: status.json is a best-effort mirror, so any unreadable shape
// degrades to "unknown" rather than blocking GC discovery.
async function readStatusFile(statusFile: string): Promise<StatusFileInfo> {
  let raw: string
  try {
    raw = await readFile(statusFile, 'utf8')
  } catch {
    return EMPTY_STATUS_INFO
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_STATUS_INFO
    const { createdAt, finishedAt, status } = parsed as {
      readonly createdAt?: unknown
      readonly finishedAt?: unknown
      readonly status?: unknown
    }
    const timestamp =
      typeof finishedAt === 'number' && Number.isFinite(finishedAt)
        ? finishedAt
        : typeof createdAt === 'number' && Number.isFinite(createdAt)
          ? createdAt
          : null
    return { timestamp, status: typeof status === 'string' ? status : null }
  } catch {
    return EMPTY_STATUS_INFO
  }
}

async function dirMtimeMs(path: string | null): Promise<number | null> {
  if (path === null) return null
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

async function listDirs(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (isMissingDir(error)) return []
    throw new Error(`Failed to read ${root}: ${errorMessage(error)}`)
  }
}

function isMissingDir(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
