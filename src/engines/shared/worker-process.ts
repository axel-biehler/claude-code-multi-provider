import type { ChildProcessByStdio } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { Readable } from 'node:stream'

const SIGKILL_GRACE_MS = 10_000

// Contains fs errors (a failed artifact write must never crash the server) and resolves
// only once the destination has flushed, so the fallback events-file read sees complete data.
export function drainToFile(source: Readable, filePath: string): Promise<void> {
  return new Promise((resolve) => {
    const destination = createWriteStream(filePath)
    destination.on('close', () => resolve())
    destination.on('error', () => resolve())
    source.on('error', () => destination.end())
    source.pipe(destination)
  })
}

export interface TimeoutGuard {
  readonly disarm: () => void
  readonly didTimeout: () => boolean
}

// SIGTERM first, then SIGKILL if the process ignores it — kill() on an already-exited
// child is a harmless no-op, so no extra liveness check is needed before the SIGKILL.
// didTimeout lets callers unmask CLIs that exit 0 on SIGTERM (observed live: a stalled
// worker was terminated at the deadline, exited 0, and the job read as succeeded).
export function armTimeoutGuard(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
): TimeoutGuard {
  let killTimer: NodeJS.Timeout | undefined
  let fired = false

  const termTimer = setTimeout(() => {
    fired = true
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS)
  }, timeoutMs)

  return {
    disarm: () => {
      clearTimeout(termTimer)
      if (killTimer) clearTimeout(killTimer)
    },
    didTimeout: () => fired,
  }
}

// A CLI may exit 0 after SIGTERM — a timed-out run must never masquerade as success.
export function unmaskTimedOutExit(rawExitCode: number, timedOut: boolean): number {
  return timedOut && rawExitCode === 0 ? -1 : rawExitCode
}
