import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { PolicySchema } from '../../src/routing/policy'
import { QuotaLedger } from '../../src/routing/quota'
import { resolveWorkerModel, resolveWorkerReasoning, selectEngine } from '../../src/routing/router'

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

  test('resolves kimi models with the same optional fallback as codex', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { kimi: { model: 'kimi-default', models: { heavy: 'kimi-heavy' } } },
    })

    // Act
    const tierModel = resolveWorkerModel(policy, 'kimi', 'heavy')
    const fallbackModel = resolveWorkerModel(policy, 'kimi', 'light')

    // Assert
    expect(tierModel).toBe('kimi-heavy')
    expect(fallbackModel).toBe('kimi-default')
  })

  test('resolves mammouth per-effort models with an optional scalar fallback', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: {
        mammouth: {
          model: 'opencode/default',
          models: { heavy: 'opencode/heavy' },
        },
      },
    })

    // Act
    const tierModel = resolveWorkerModel(policy, 'mammouth', 'heavy')
    const fallbackModel = resolveWorkerModel(policy, 'mammouth', 'light')

    // Assert
    expect(tierModel).toBe('opencode/heavy')
    expect(fallbackModel).toBe('opencode/default')
  })
})

describe('resolveWorkerReasoning', () => {
  test('returns a scalar setting for any effort tier', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { codex: { reasoning: 'high' } },
    })

    // Act
    const light = resolveWorkerReasoning(policy, 'codex', 'light')
    const heavy = resolveWorkerReasoning(policy, 'codex', 'heavy')

    // Assert
    expect(light).toBe('high')
    expect(heavy).toBe('high')
  })

  test('returns the requested map tier and defaults undefined effort to standard', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: {
        claude: { reasoning: { standard: 'medium', heavy: 'xhigh' } },
      },
    })

    // Act
    const standard = resolveWorkerReasoning(policy, 'claude')
    const heavy = resolveWorkerReasoning(policy, 'claude', 'heavy')

    // Assert
    expect(standard).toBe('medium')
    expect(heavy).toBe('xhigh')
  })

  test('returns undefined when the requested tier is missing from a map', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { antigravity: { reasoning: { light: 'low' } } },
    })

    // Act
    const reasoning = resolveWorkerReasoning(policy, 'antigravity', 'heavy')

    // Assert
    expect(reasoning).toBeUndefined()
  })

  test('resolves mammouth per-effort reasoning without cross-tier fallback', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { mammouth: { reasoning: { light: 'low', heavy: 'max' } } },
    })

    // Act
    const heavy = resolveWorkerReasoning(policy, 'mammouth', 'heavy')
    const standard = resolveWorkerReasoning(policy, 'mammouth', 'standard')

    // Assert
    expect(heavy).toBe('max')
    expect(standard).toBeUndefined()
  })

  test('returns undefined when reasoning is absent', () => {
    // Arrange
    const policy = PolicySchema.parse({})

    // Act
    const reasoning = resolveWorkerReasoning(policy, 'codex', 'standard')

    // Assert
    expect(reasoning).toBeUndefined()
  })

  test('returns undefined for kimi at every effort tier', () => {
    // Arrange
    const policy = PolicySchema.parse({
      workers: { kimi: { models: { heavy: 'kimi-heavy' } } },
    })

    // Act + Assert
    expect(resolveWorkerReasoning(policy, 'kimi', 'light')).toBeUndefined()
    expect(resolveWorkerReasoning(policy, 'kimi', 'standard')).toBeUndefined()
    expect(resolveWorkerReasoning(policy, 'kimi', 'heavy')).toBeUndefined()
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

  test('routes through kimi when it is next in the configured chain', async () => {
    // Arrange
    const policy = PolicySchema.parse({ chain: ['codex', 'kimi', 'claude'] })
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.markExhausted('codex', 60)

    // Act
    const selected = selectEngine(policy, ledger)

    // Assert
    expect(selected).toBe('kimi')
  })

  test('routes through mammouth when it is next in the configured chain', async () => {
    // Arrange
    const policy = PolicySchema.parse({
      chain: ['codex', 'mammouth', 'antigravity', 'claude'],
    })
    const ledger = await QuotaLedger.load(repoRoot, now)
    await ledger.markExhausted('codex', 60)

    // Act
    const selected = selectEngine(policy, ledger)

    // Assert
    expect(selected).toBe('mammouth')
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
