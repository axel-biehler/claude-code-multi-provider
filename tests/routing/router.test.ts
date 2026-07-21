import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { PolicySchema } from '../../src/routing/policy'
import { QuotaLedger } from '../../src/routing/quota'
import { resolveWorkerModel, selectEngine } from '../../src/routing/router'

describe('resolveWorkerModel', () => {
  test('returns the requested tier model when configured', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { claude: { model: 'fallback', models: { heavy: 'tier-heavy' } } },
    })

    // Act
    const model = resolveWorkerModel(policy, 'claude', 'heavy')

    // Assert
    expect(model).toBe('tier-heavy')
  })

  test('falls back to the scalar model when the requested tier is not configured', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { claude: { model: 'fallback', models: { light: 'tier-light' } } },
    })

    // Act
    const model = resolveWorkerModel(policy, 'claude', 'heavy')

    // Assert
    expect(model).toBe('fallback')
  })

  test('uses the standard tier for undefined effort and otherwise falls back to the scalar model', () => {
    // Arrange
    const withStandardTier = PolicySchema.parse({
      workers: { claude: { model: 'fallback', models: { standard: 'tier-standard' } } },
    })
    const withoutStandardTier = PolicySchema.parse({
      workers: { claude: { model: 'fallback', models: { heavy: 'tier-heavy' } } },
    })

    // Act
    const tierModel = resolveWorkerModel(withStandardTier, 'claude')
    const fallbackModel = resolveWorkerModel(withoutStandardTier, 'claude')

    // Assert
    expect(tierModel).toBe('tier-standard')
    expect(fallbackModel).toBe('fallback')
  })

  test('returns undefined for codex when neither a tier nor scalar model is configured', () => {
    // Arrange
    const policy = PolicySchema.parse({})

    // Act
    const model = resolveWorkerModel(policy, 'codex', 'light')

    // Assert
    expect(model).toBeUndefined()
  })

  test('resolves antigravity models with the same optional fallback as codex', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { antigravity: { models: { heavy: 'gemini-heavy' } } },
    })

    // Act
    const tierModel = resolveWorkerModel(policy, 'antigravity', 'heavy')
    const fallbackModel = resolveWorkerModel(policy, 'antigravity', 'light')

    // Assert
    expect(tierModel).toBe('gemini-heavy')
    expect(fallbackModel).toBeUndefined()
  })
})

describe('selectEngine', () => {
  let repoRoot: string
  let t: number
  const now = () => t

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-router-'))
    t = 1_000_000
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('returns the first chain engine when every engine has headroom', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Act
    const selected = selectEngine(policy, ledger)

    // Assert
    expect(selected).toBe('codex')
  })

  test('falls through to the next engine when the first is marked exhausted', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.markExhausted('codex', policy.quotas.codex.exhaustionCooldownMinutes)

    // Act
    const selected = selectEngine(policy, ledger)

    // Assert
    expect(selected).toBe('claude')
  })

  test('routes through antigravity when it is next in the configured chain', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'antigravity', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.markExhausted('codex', 60)

    // Act
    const selected = selectEngine(policy, ledger)

    // Assert
    expect(selected).toBe('antigravity')
  })

  test('falls through when ok-records consume the first engine 5h cap', async () => {
    // Arrange
    const policy = PolicySchema.parse({
      chain: ['codex', 'claude'],
      quotas: { codex: { maxJobsPer5h: 2 } },
    })
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.record({ engine: 'codex', durationMs: 1_000, outcome: 'ok' })
    await ledger.record({ engine: 'codex', durationMs: 1_000, outcome: 'ok' })

    // Act
    const selected = selectEngine(policy, ledger)

    // Assert
    expect(selected).toBe('claude')
  })

  test('returns null when every chain engine is exhausted', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.markExhausted('codex', 60)
    await ledger.markExhausted('claude', 60)

    // Act
    const selected = selectEngine(policy, ledger)

    // Assert
    expect(selected).toBeNull()
  })

  test('honors a single-engine chain and never falls back to an engine outside it', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['claude'] })
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Act
    const withHeadroom = selectEngine(policy, ledger)
    await ledger.markExhausted('claude', 60)
    const whenExhausted = selectEngine(policy, ledger)

    // Assert
    expect(withHeadroom).toBe('claude')
    expect(whenExhausted).toBeNull()
  })

  test('selects the first engine again once its exhaustion cooldown elapses', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const cooldownMinutes = policy.quotas.codex.exhaustionCooldownMinutes
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.markExhausted('codex', cooldownMinutes)

    // Act
    const duringCooldown = selectEngine(policy, ledger)
    t += cooldownMinutes * 60_000
    const afterCooldown = selectEngine(policy, ledger)

    // Assert
    expect(duringCooldown).toBe('claude')
    expect(afterCooldown).toBe('codex')
  })

  test('skips an excluded engine and selects the next eligible engine', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Act
    const selected = selectEngine(policy, ledger, 'codex')

    // Assert
    expect(selected).toBe('claude')
  })

  test('returns null when exclusion leaves no eligible engine', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex'] })
    const ledger = await QuotaLedger.load(repoRoot, now)

    // Act
    const selected = selectEngine(policy, ledger, 'codex')

    // Assert
    expect(selected).toBeNull()
  })
})
