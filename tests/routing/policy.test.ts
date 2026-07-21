import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { DEFAULT_POLICY, PolicySchema, loadPolicy } from '../../src/routing/policy'

const EXAMPLE_POLICY_PATH = fileURLToPath(new URL('../../policy.example.yaml', import.meta.url))

describe('PolicySchema', () => {
  test('parsing an empty object yields the fully-defaulted policy', () => {
    // Arrange
    const emptyConfig = {}

    // Act
    const policy = PolicySchema.parse(emptyConfig)

    // Assert
    expect(policy.chain).toEqual(['codex', 'claude'])
    expect(policy.maxConcurrentJobs).toBe(2)
    expect(policy.workers.codex.timeoutMs).toBe(600_000)
    expect(policy.workers.codex.model).toBeUndefined()
    expect(policy.workers.claude.model).toBe('sonnet')
    expect(policy.workers.claude.maxBudgetUsd).toBe(2)
    expect(policy.quotas.codex.maxJobsPer5h).toBe(10)
    expect(policy.quotas.claude.maxJobsPerWeek).toBe(50)
    expect(policy.retention).toEqual({ maxAgeDays: 7, keepLast: 10 })
  })

  test('accepts a model override for the codex worker', () => {
    // Arrange
    const config = { workers: { codex: { model: 'gpt-5.6-sol' } } }

    // Act
    const policy = PolicySchema.parse(config)

    // Assert
    expect(policy.workers.codex.model).toBe('gpt-5.6-sol')
  })

  test('accepts per-tier worker models', () => {
    // Arrange
    const config = {
      workers: {
        codex: { models: { light: 'gpt-light', heavy: 'gpt-heavy' } },
        claude: { models: { standard: 'claude-standard' } },
      },
    }

    // Act
    const policy = PolicySchema.parse(config)

    // Assert
    expect(policy.workers.codex.models).toEqual({ light: 'gpt-light', heavy: 'gpt-heavy' })
    expect(policy.workers.claude.models).toEqual({ standard: 'claude-standard' })
  })

  test('keeps scalar model defaults when per-tier models are omitted', () => {
    // Arrange
    const config = { workers: { codex: {}, claude: {} } }

    // Act
    const policy = PolicySchema.parse(config)

    // Assert
    expect(policy.workers.codex.models).toBeUndefined()
    expect(policy.workers.codex.model).toBeUndefined()
    expect(policy.workers.claude.models).toBeUndefined()
    expect(policy.workers.claude.model).toBe('sonnet')
  })

  test('the committed policy.example.yaml validates and matches the defaults exactly', async () => {
    // Arrange
    const raw = await readFile(EXAMPLE_POLICY_PATH, 'utf8')

    // Act
    const policy = PolicySchema.parse(parse(raw))

    // Assert
    expect(policy).toEqual(DEFAULT_POLICY)
  })
})

describe('loadPolicy', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-policy-'))
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('returns DEFAULT_POLICY when policy.yaml is absent', async () => {
    // Arrange — beforeEach created repoRoot with no policy.yaml in it

    // Act
    const policy = await loadPolicy(repoRoot)

    // Assert
    expect(policy).toEqual(DEFAULT_POLICY)
  })

  test('applies partial overrides and keeps the remaining defaults', async () => {
    // Arrange
    const partialYaml = 'chain: [claude]\nretention:\n  maxAgeDays: 3\n'
    await writeFile(join(repoRoot, 'policy.yaml'), partialYaml, 'utf8')

    // Act
    const policy = await loadPolicy(repoRoot)

    // Assert
    expect(policy.chain).toEqual(['claude'])
    expect(policy.retention.maxAgeDays).toBe(3)
    expect(policy.retention.keepLast).toBe(10)
    expect(policy.maxConcurrentJobs).toBe(2)
    expect(policy.workers.claude.model).toBe('sonnet')
    expect(policy.quotas.codex.maxJobsPer5h).toBe(10)
  })

  test('throws an error naming the file path when the schema is violated', async () => {
    // Arrange
    const policyPath = join(repoRoot, 'policy.yaml')
    await writeFile(policyPath, 'chain: [gpt5]\n', 'utf8')

    // Act
    const attempt = loadPolicy(repoRoot)

    // Assert
    await expect(attempt).rejects.toThrow(policyPath)
  })

  test('throws an error naming the file path on malformed YAML', async () => {
    // Arrange
    const policyPath = join(repoRoot, 'policy.yaml')
    await writeFile(policyPath, 'chain: [codex\n', 'utf8')

    // Act
    const attempt = loadPolicy(repoRoot)

    // Assert
    await expect(attempt).rejects.toThrow(policyPath)
  })
})
