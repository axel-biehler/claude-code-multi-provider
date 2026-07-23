import type { ChildProcessByStdio } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { Readable } from 'node:stream'

const SIGKILL_GRACE_MS = 10_000

// The bundled codex runs as a Node wrapper that spawns the real binary as a grandchild.
// On POSIX a signal to the process reaches it; on Windows child.kill() force-terminates
// ONLY the named process (signals are ignored there), orphaning that grandchild — so on
// win32 the whole tree is killed by pid via taskkill /T. Injectable for tests.
export type TreeKiller = (pid: number) => void

const taskkillTree: TreeKiller = (pid) => {
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on(
      'error',
      () => undefined,
    )
  } catch {
    // Best-effort: a failed tree-kill must never throw out of the timeout timer.
  }
}

export interface TerminateOptions {
  readonly platform?: NodeJS.Platform
  readonly treeKill?: TreeKiller
}

function terminateChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  signal: NodeJS.Signals,
  options: TerminateOptions,
): void {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (child.pid !== undefined) (options.treeKill ?? taskkillTree)(child.pid)
    return
  }
  child.kill(signal)
}

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
  options: TerminateOptions = {},
): TimeoutGuard {
  let killTimer: NodeJS.Timeout | undefined
  let fired = false

  const termTimer = setTimeout(() => {
    fired = true
    terminateChild(child, 'SIGTERM', options)
    killTimer = setTimeout(() => terminateChild(child, 'SIGKILL', options), SIGKILL_GRACE_MS)
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
