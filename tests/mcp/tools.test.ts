import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import {
  buildCheckDelegationsPayload,
  buildConfigureDelegationDetectPayload,
  parseConfigureDelegationWriteInput,
  writeDelegationPolicy,
} from '../../src/mcp/tools'
import { PolicySchema } from '../../src/routing/policy'

describe('buildCheckDelegationsPayload', () => {
  test('returns server boot metadata and jobs in the check_delegations payload shape', () => {
    // Arrange
    const serverInfo = { bootedAt: 1_753_953_600_000, gitRev: 'abc1234' }
    const jobs = [
      {
        job_id: 'job-1',
        status: 'running',
        objective: 'Add boot visibility',
        durationMs: 42,
      },
    ]

    // Act
    const payload = buildCheckDelegationsPayload(serverInfo, jobs)

    // Assert
    expect(payload).toEqual({ server: serverInfo, jobs })
  })

  test('passes the jobs array content through unchanged', () => {
    // Arrange
    const serverInfo = { bootedAt: 1_753_953_600_000, gitRev: 'abc1234' }
    const jobs = [
      { job_id: 'job-1', status: 'queued', objective: 'First job', durationMs: undefined },
      { job_id: 'job-2', status: 'succeeded', objective: 'Second job', durationMs: 125 },
    ]

    // Act
    const payload = buildCheckDelegationsPayload(serverInfo, jobs)

    // Assert
    expect(payload.jobs).toBe(jobs)
  })
})

describe('configure_delegation logic', () => {
  const temporaryRoots: string[] = []
  const discoveredModels = {
    codex: {
      models: [{ id: 'gpt-5.6-sol', recommended: true }],
      source: 'catalog',
      defaultModel: 'gpt-5.6-sol',
    },
    claude: {
      models: [{ id: 'sonnet', recommended: true }],
      source: 'catalog',
      defaultModel: 'sonnet',
    },
    antigravity: {
      models: [{ id: 'gemini-3.6-flash-high', recommended: true }],
      source: 'cli',
    },
  } as const

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  test('builds the detect payload with provider detection and discovered model details', () => {
    // Arrange
    const providers = {
      codex: { available: true, detail: 'binary: /opt/local/bin/codex' },
      claude: { available: false, detail: 'auth: missing credentials' },
      antigravity: { available: true, detail: 'binary: /usr/local/bin/agy' },
    }
    const policy = PolicySchema.parse({
      chain: ['codex', 'antigravity'],
      workers: {
        claude: { model: 'opus' },
        antigravity: { model: 'gemini-3.5-flash-high' },
      },
    })

    // Act
    const payload = buildConfigureDelegationDetectPayload(
      providers,
      discoveredModels,
      policy,
    )

    // Assert
    expect(payload).toEqual({
      providers: {
        codex: {
          available: true,
          detail: 'binary: /opt/local/bin/codex',
          models: [{ id: 'gpt-5.6-sol', recommended: true }],
          modelsSource: 'catalog',
          defaultModel: 'gpt-5.6-sol',
        },
        claude: {
          available: false,
          detail: 'auth: missing credentials',
          models: [{ id: 'sonnet', recommended: true }],
          modelsSource: 'catalog',
          defaultModel: 'sonnet',
        },
        antigravity: {
          available: true,
          detail: 'binary: /usr/local/bin/agy',
          models: [{ id: 'gemini-3.6-flash-high', recommended: true }],
          modelsSource: 'cli',
        },
      },
      currentPolicy: {
        chain: ['codex', 'antigravity'],
        models: { claude: 'opus', antigravity: 'gemini-3.5-flash-high' },
      },
    })
    expect(payload.providers.antigravity).not.toHaveProperty('defaultModel')
    expect(payload.providers.codex.models).toBe(discoveredModels.codex.models)
  })

  test('returns a null current policy without changing provider details', () => {
    // Arrange
    const providers = {
      codex: { available: true, detail: 'codex detail' },
      claude: { available: false, detail: 'claude detail' },
      antigravity: { available: false, detail: 'antigravity detail' },
    }

    // Act
    const payload = buildConfigureDelegationDetectPayload(
      providers,
      discoveredModels,
      null,
    )

    // Assert
    expect(payload.currentPolicy).toBeNull()
    expect(payload.providers.codex.detail).toBe('codex detail')
  })

  test('includes configured model tiers in the detect payload', () => {
    // Arrange
    const providers = {
      codex: { available: true, detail: 'authenticated' },
      claude: { available: true, detail: 'authenticated' },
      antigravity: { available: true, detail: 'authenticated' },
    }
    const policy = PolicySchema.parse({
      workers: {
        codex: { models: { light: 'small', heavy: 'big' } },
        claude: { models: { standard: 'medium' } },
        antigravity: { models: { heavy: 'gemini-heavy' } },
      },
    })

    // Act
    const payload = buildConfigureDelegationDetectPayload(
      providers,
      discoveredModels,
      policy,
    )

    // Assert
    expect(payload.currentPolicy?.modelTiers).toEqual({
      codex: { light: 'small', heavy: 'big' },
      claude: { standard: 'medium' },
      antigravity: { heavy: 'gemini-heavy' },
    })
  })

  test.each([
    ['a scalar model', { codex: 'gpt-x' }],
    ['a tier model map', { claude: { light: 'small', heavy: 'big' } }],
    ['an antigravity model', { antigravity: 'gemini-3.5-flash-high' }],
  ])('accepts %s in write input', (_label, models) => {
    expect(
      parseConfigureDelegationWriteInput({ action: 'write', chain: ['codex'], models }),
    ).toMatchObject({ models })
  })

  test('rejects an empty write chain', () => {
    expect(() =>
      parseConfigureDelegationWriteInput({ action: 'write', chain: [], models: {} }),
    ).toThrow()
  })

  test('rejects an unknown engine in the write chain', () => {
    expect(() =>
      parseConfigureDelegationWriteInput({
        action: 'write',
        chain: ['unknown'],
        models: {},
      }),
    ).toThrow()
  })

  test('rejects an unknown engine in the write models', () => {
    expect(() =>
      parseConfigureDelegationWriteInput({
        action: 'write',
        chain: ['claude'],
        models: { unknown: 'model' },
      }),
    ).toThrow()
  })

  test('writes and returns a merge-safe policy from a temporary repository', async () => {
    // Arrange
    const repoRoot = await mkdtemp(join(tmpdir(), 'delegate-mcp-tools-'))
    temporaryRoots.push(repoRoot)
    await writeFile(
      join(repoRoot, 'policy.yaml'),
      'chain: [codex]\nworkers:\n  codex:\n    timeoutMs: 123456\n  claude:\n    model: sonnet\n',
      'utf8',
    )

    // Act
    const result = await writeDelegationPolicy(repoRoot, {
      action: 'write',
      chain: ['claude'],
      models: { claude: 'opus' },
    })

    // Assert
    expect(result).toEqual({ chain: ['claude'], models: { claude: 'opus' } })
    const written = parse(await readFile(join(repoRoot, 'policy.yaml'), 'utf8')) as {
      workers: { codex: { timeoutMs: number } }
    }
    expect(written.workers.codex.timeoutMs).toBe(123456)
  })

  test('writes and returns per-tier worker models', async () => {
    // Arrange
    const repoRoot = await mkdtemp(join(tmpdir(), 'delegate-mcp-tools-'))
    temporaryRoots.push(repoRoot)
    await writeFile(join(repoRoot, 'policy.yaml'), 'chain: [codex]\n', 'utf8')

    // Act
    const result = await writeDelegationPolicy(repoRoot, {
      action: 'write',
      chain: ['claude'],
      models: { claude: { heavy: 'big', light: 'small' } },
    })

    // Assert
    expect(result).toEqual({
      chain: ['claude'],
      models: { claude: 'sonnet' },
      modelTiers: { claude: { heavy: 'big', light: 'small' } },
    })
    const written = PolicySchema.parse(
      parse(await readFile(join(repoRoot, 'policy.yaml'), 'utf8')),
    )
    expect(written.workers.claude.models).toEqual({ heavy: 'big', light: 'small' })
  })
})
