import { join } from 'node:path'
import type { JobPaths } from '../types'

export function buildJobPaths(repoRoot: string, jobId: string): JobPaths {
  const jobDir = join(repoRoot, '.delegate', 'jobs', jobId)
  return {
    jobDir,
    promptFile: join(jobDir, 'prompt.md'),
    eventsFile: join(jobDir, 'events.ndjson'),
    stderrFile: join(jobDir, 'stderr.log'),
    lastMessageFile: join(jobDir, 'last-message.md'),
    diffFile: join(jobDir, 'diff.patch'),
    statusFile: join(jobDir, 'status.json'),
  }
}
