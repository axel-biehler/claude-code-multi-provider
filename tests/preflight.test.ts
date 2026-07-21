import { describe, expect, test } from 'vitest'
import { computeVerdict, parsePreflightArgs } from '../scripts/preflight'

describe('parsePreflightArgs', () => {
  test('defaults to live probes on when no flags are given', () => {
    // Arrange
    const argv: readonly string[] = []

    // Act
    const args = parsePreflightArgs(argv)

    // Assert
    expect(args.probe).toBe(true)
  })

  test('--no-probe turns live probes off', () => {
    // Arrange
    const argv = ['--no-probe']

    // Act
    const args = parsePreflightArgs(argv)

    // Assert
    expect(args.probe).toBe(false)
  })
})

describe('computeVerdict', () => {
  test('fails when a core check fails even with a fully usable engine', () => {
    // Arrange
    const input = {
      coreOk: false,
      engines: [{ engine: 'codex', staticOk: true, probeOk: true }],
    }

    // Act
    const verdict = computeVerdict(input)

    // Assert
    expect(verdict.exitCode).toBe(1)
  })

  test('passes and lists the one usable engine when the other is sick', () => {
    // Arrange
    const input = {
      coreOk: true,
      engines: [
        { engine: 'codex', staticOk: true, probeOk: false },
        { engine: 'claude', staticOk: true, probeOk: true },
      ],
    }

    // Act
    const verdict = computeVerdict(input)

    // Assert
    expect(verdict.exitCode).toBe(0)
    expect(verdict.usableEngines).toEqual(['claude'])
  })

  test('fails when every engine is static-ok but all probes failed', () => {
    // Arrange
    const input = {
      coreOk: true,
      engines: [
        { engine: 'codex', staticOk: true, probeOk: false },
        { engine: 'claude', staticOk: true, probeOk: false },
      ],
    }

    // Act
    const verdict = computeVerdict(input)

    // Assert
    expect(verdict.exitCode).toBe(1)
    expect(verdict.usableEngines).toEqual([])
  })

  test('counts a static-ok engine as usable when probes were skipped', () => {
    // Arrange
    const input = {
      coreOk: true,
      engines: [{ engine: 'claude', staticOk: true, probeOk: null }],
    }

    // Act
    const verdict = computeVerdict(input)

    // Assert
    expect(verdict.exitCode).toBe(0)
    expect(verdict.usableEngines).toEqual(['claude'])
  })

  test('treats a static-failed engine as unusable even when probes were skipped', () => {
    // Arrange
    const input = {
      coreOk: true,
      engines: [{ engine: 'codex', staticOk: false, probeOk: null }],
    }

    // Act
    const verdict = computeVerdict(input)

    // Assert
    expect(verdict.exitCode).toBe(1)
    expect(verdict.usableEngines).toEqual([])
  })
})
