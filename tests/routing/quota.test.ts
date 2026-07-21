import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QuotaLedger, WINDOW_5H_MS, WINDOW_WEEK_MS } from '../../src/routing/quota'
import type { QuotaConfig } from '../../src/types'

const QUOTA: QuotaConfig = {
  maxJobsPer5h: 2,
  maxJobsPerWeek: 3,
  exhaustionCooldownMinutes: 30,
}

describe('QuotaLedger', () => {
  let repoRoot: string
  let t: number
  const now = () => t

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-quota-'))
    t = 1_000_000
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  test('hasHeadroom returns true for every engine on an empty ledger', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Act
    const codexHeadroom = ledger.hasHeadroom('codex', QUOTA)
    const claudeHeadroom = ledger.hasHeadroom('claude', QUOTA)
    const antigravityHeadroom = ledger.hasHeadroom('antigravity', QUOTA)

    // Assert
    expect(codexHeadroom).toBe(true)
    expect(claudeHeadroom).toBe(true)
    expect(antigravityHeadroom).toBe(true)
  })

  test('counts only ok and other outcomes toward caps, not quota or auth attempts', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'quota' })
    await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'auth' })
    await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'quota' })

    // Act
    const afterFreeFailures = ledger.hasHeadroom('codex', QUOTA)
    await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'ok' })
    await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'other' })
    const afterConsumingRuns = ledger.hasHeadroom('codex', QUOTA)

    // Assert
    expect(afterFreeFailures).toBe(true)
    expect(afterConsumingRuns).toBe(false)
  })

  test('blocks after maxJobsPer5h consuming runs and frees once the 5h window slides past', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)
    for (let i = 0; i < QUOTA.maxJobsPer5h; i += 1) {
      await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'ok' })
    }

    // Act
    const blocked = ledger.hasHeadroom('codex', QUOTA)
    t += WINDOW_5H_MS + 1
    const afterWindow = ledger.hasHeadroom('codex', QUOTA)

    // Assert
    expect(blocked).toBe(false)
    expect(afterWindow).toBe(true)
  })

  test('weekly cap blocks even when the 5h window is clear', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)
    const firstAt = t
    for (let i = 0; i < QUOTA.maxJobsPerWeek; i += 1) {
      await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'ok' })
      t += WINDOW_5H_MS + 1
    }

    // Act — every attempt is now outside the 5h window but inside the week
    const blockedByWeek = ledger.hasHeadroom('codex', QUOTA)
    t = firstAt + WINDOW_WEEK_MS + 1
    const afterOldestExpires = ledger.hasHeadroom('codex', QUOTA)

    // Assert
    expect(blockedByWeek).toBe(false)
    expect(afterOldestExpires).toBe(true)
  })

  test('markExhausted blocks the engine immediately and frees after the cooldown', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Act
    await ledger.markExhausted('codex', QUOTA.exhaustionCooldownMinutes)
    const duringCooldown = ledger.hasHeadroom('codex', QUOTA)
    const otherEngine = ledger.hasHeadroom('claude', QUOTA)
    t += QUOTA.exhaustionCooldownMinutes * 60_000
    const afterCooldown = ledger.hasHeadroom('codex', QUOTA)

    // Assert
    expect(duringCooldown).toBe(false)
    expect(otherEngine).toBe(true)
    expect(afterCooldown).toBe(true)
  })

  test('markExhaustedUntil blocks only until the supplied absolute timestamp', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)
    const untilMs = t + 12_345

    // Act
    await ledger.markExhaustedUntil('codex', untilMs)
    const duringCooldown = ledger.hasHeadroom('codex', QUOTA)
    t = untilMs
    const atCooldownEnd = ledger.hasHeadroom('codex', QUOTA)

    // Assert
    expect(ledger.snapshot().exhaustedUntil.codex).toBe(untilMs)
    expect(duringCooldown).toBe(false)
    expect(atCooldownEnd).toBe(true)
  })

  test('record prunes attempts older than 7 days', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.record({ engine: 'codex', durationMs: 10, outcome: 'ok' })

    // Act
    t += WINDOW_WEEK_MS + 1
    await ledger.record({ engine: 'codex', durationMs: 20, outcome: 'ok' })
    const state = ledger.snapshot()

    // Assert
    expect(state.attempts).toHaveLength(1)
    expect(state.attempts[0]?.at).toBe(t)
    expect(state.attempts[0]?.durationMs).toBe(20)
  })

  test('persists across restarts: a fresh load returns an identical snapshot', async () => {
    // Arrange
    const original = await QuotaLedger.load(repoRoot, now)
    await original.record({ engine: 'codex', durationMs: 1200, outcome: 'ok' })
    await original.record({ engine: 'claude', durationMs: 800, outcome: 'other' })
    await original.record({ engine: 'antigravity', durationMs: 600, outcome: 'ok' })
    await original.markExhausted('codex', 45)
    await original.markExhausted('antigravity', 30)

    // Act
    const reloaded = await QuotaLedger.load(repoRoot, now)

    // Assert
    expect(reloaded.snapshot()).toEqual(original.snapshot())
    expect(reloaded.snapshot().attempts).toHaveLength(3)
    expect(reloaded.snapshot().exhaustedUntil.codex).toBe(t + 45 * 60_000)
    expect(reloaded.snapshot().exhaustedUntil.antigravity).toBe(t + 30 * 60_000)
  })

  test('load starts fresh without throwing when the ledger file is corrupt', async () => {
    // Arrange
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mkdir(join(repoRoot, '.delegate'), { recursive: true })
    await writeFile(join(repoRoot, '.delegate', 'quota-ledger.json'), '{ not json', 'utf8')

    // Act
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Assert
    expect(ledger.snapshot()).toEqual({ attempts: [], exhaustedUntil: {} })
    expect(ledger.hasHeadroom('codex', QUOTA)).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
  })

  test('load starts fresh when the ledger file is valid JSON but an invalid shape', async () => {
    // Arrange
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mkdir(join(repoRoot, '.delegate'), { recursive: true })
    await writeFile(
      join(repoRoot, '.delegate', 'quota-ledger.json'),
      JSON.stringify({ attempts: [{ engine: 'gemini', at: 'yesterday' }] }),
      'utf8'
    )

    // Act
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Assert
    expect(ledger.snapshot()).toEqual({ attempts: [], exhaustedUntil: {} })
    expect(warn).toHaveBeenCalledOnce()
  })

  test('serializes concurrent record calls so every attempt survives to disk', async () => {
    // Arrange
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Act
    await Promise.all([
      ledger.record({ engine: 'codex', durationMs: 1, outcome: 'ok' }),
      ledger.record({ engine: 'claude', durationMs: 2, outcome: 'ok' }),
      ledger.record({ engine: 'codex', durationMs: 3, outcome: 'other' }),
      ledger.record({ engine: 'claude', durationMs: 4, outcome: 'quota' }),
      ledger.record({ engine: 'codex', durationMs: 5, outcome: 'auth' }),
    ])
    const reloaded = await QuotaLedger.load(repoRoot, now)

    // Assert
    expect(reloaded.snapshot().attempts).toHaveLength(5)
  })
})
