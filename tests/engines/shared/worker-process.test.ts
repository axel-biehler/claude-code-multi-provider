import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { armTimeoutGuard, unmaskTimedOutExit } from '../../../src/engines/shared/worker-process'

describe('unmaskTimedOutExit', () => {
  test.each([
    ['a timed-out zero exit becomes -1', 0, true, -1],
    ['a timed-out non-zero exit is preserved', 143, true, 143],
    ['a normal zero exit stays 0', 0, false, 0],
    ['a normal failure exit stays as-is', 1, false, 1],
  ])('%s', (_label, rawExitCode, timedOut, expected) => {
    // Arrange + Act
    const exitCode = unmaskTimedOutExit(rawExitCode, timedOut)

    // Assert
    expect(exitCode).toBe(expected)
  })
})

describe('armTimeoutGuard', () => {
  function stubChild(pid?: number): {
    child: ChildProcessByStdio<null, Readable, Readable>
    kill: ReturnType<typeof vi.fn>
  } {
    const kill = vi.fn()
    return {
      child: { kill, pid } as unknown as ChildProcessByStdio<null, Readable, Readable>,
      kill,
    }
  }

  test('reports a fired timeout and escalates SIGTERM to SIGKILL', () => {
    // Arrange
    vi.useFakeTimers()
    const { child, kill } = stubChild()
    const guard = armTimeoutGuard(child, 1_000, { platform: 'linux' })

    // Act
    vi.advanceTimersByTime(1_000)
    const firedAfterDeadline = guard.didTimeout()
    vi.advanceTimersByTime(10_000)
    guard.disarm()
    vi.useRealTimers()

    // Assert
    expect(firedAfterDeadline).toBe(true)
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  test('on win32 kills the whole process tree by pid instead of signaling the wrapper', () => {
    // Arrange — Windows ignores kill() signals and would orphan codex's native grandchild.
    vi.useFakeTimers()
    const { child, kill } = stubChild(4321)
    const treeKill = vi.fn()
    const guard = armTimeoutGuard(child, 1_000, { platform: 'win32', treeKill })

    // Act
    vi.advanceTimersByTime(1_000)
    vi.advanceTimersByTime(10_000)
    guard.disarm()
    vi.useRealTimers()

    // Assert
    expect(kill).not.toHaveBeenCalled()
    expect(treeKill).toHaveBeenCalledWith(4321)
  })

  test('disarming before the deadline prevents any kill and reports no timeout', () => {
    // Arrange
    vi.useFakeTimers()
    const { child, kill } = stubChild()
    const guard = armTimeoutGuard(child, 1_000)

    // Act
    guard.disarm()
    vi.advanceTimersByTime(60_000)
    vi.useRealTimers()

    // Assert
    expect(guard.didTimeout()).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})
