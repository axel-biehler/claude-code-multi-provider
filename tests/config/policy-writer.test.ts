import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import { renderPolicyYaml, writePolicyFile } from '../../src/config/policy-writer'
import { PolicySchema, loadPolicy } from '../../src/routing/policy'

describe('renderPolicyYaml', () => {
  test('changes only the requested worker model in a customized policy', () => {
    // Arrange
    const current = `# keep this policy comment
chain: [codex, claude]
maxConcurrentJobs: 7
workers:
  codex:
    timeoutMs: 123456
  claude:
    model: sonnet # keep this model comment
    maxBudgetUsd: 9
    timeoutMs: 654321
quotas:
  codex:
    maxJobsPer5h: 3
    maxJobsPerWeek: 17
    exhaustionCooldownMinutes: 91
  claude:
    maxJobsPer5h: 4
    maxJobsPerWeek: 18
    exhaustionCooldownMinutes: 92
retention:
  maxAgeDays: 22
  keepLast: 31
`
    const before = parse(current) as Record<string, unknown>

    // Act
    const rendered = renderPolicyYaml(current, { models: { claude: 'opus' } })
    const after = parse(rendered) as Record<string, unknown>

    // Assert
    expect(after).toEqual({
      ...before,
      workers: {
        ...(before.workers as Record<string, unknown>),
        claude: {
          ...((before.workers as Record<string, unknown>).claude as Record<string, unknown>),
          model: 'opus',
        },
      },
    })
    expect(rendered).toContain('# keep this policy comment')
    expect(rendered).toContain('# keep this model comment')
    expect(PolicySchema.parse(after).workers.claude.model).toBe('opus')
  })

  test('writes per-tier worker models and round-trips through the policy schema', () => {
    // Act
    const rendered = renderPolicyYaml(null, {
      models: { claude: { heavy: 'big', light: 'small' } },
    })
    const policy = PolicySchema.parse(parse(rendered))

    // Assert
    expect(policy.workers.claude.models).toEqual({ heavy: 'big', light: 'small' })
  })

  test('starts from complete defaults when no current policy exists', () => {
    // Act
    const rendered = renderPolicyYaml(null, {
      chain: ['claude'],
      models: { claude: 'sonnet' },
    })
    const policy = PolicySchema.parse(parse(rendered))

    // Assert
    expect(policy.chain).toEqual(['claude'])
    expect(policy.workers.claude.model).toBe('sonnet')
    expect(policy.maxConcurrentJobs).toBe(2)
    expect(policy.quotas.codex.maxJobsPer5h).toBe(10)
  })

  test('does not write to stdout', () => {
    // Arrange
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    // Act
    renderPolicyYaml(null, { models: { codex: 'gpt-test' } })

    // Assert
    expect(stdout).not.toHaveBeenCalled()
    stdout.mockRestore()
  })

  test('rejects malformed current YAML before rendering a patch', () => {
    // Act
    const attempt = () => renderPolicyYaml('chain: [codex\n', { chain: ['claude'] })

    // Assert
    expect(attempt).toThrow('Invalid policy YAML')
  })
})

describe('writePolicyFile', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-policy-writer-'))
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('updates an existing partial policy without materializing unrelated defaults', async () => {
    // Arrange
    const current = '# local settings\nmaxConcurrentJobs: 6\nworkers:\n  claude:\n    model: sonnet\n'
    await writeFile(join(repoRoot, 'policy.yaml'), current, 'utf8')

    // Act
    await writePolicyFile(repoRoot, { models: { claude: 'opus' } })

    // Assert
    const written = await readFile(join(repoRoot, 'policy.yaml'), 'utf8')
    expect(parse(written)).toEqual({
      maxConcurrentJobs: 6,
      workers: { claude: { model: 'opus' } },
    })
    expect(written).toContain('# local settings')
  })

  test('seeds the first policy write from policy.example.yaml comments', async () => {
    // Arrange
    const example = '# example guidance\nchain: [codex, claude]\nworkers:\n  claude:\n    model: sonnet\n'
    await writeFile(join(repoRoot, 'policy.example.yaml'), example, 'utf8')

    // Act
    await writePolicyFile(repoRoot, { chain: ['claude'] })

    // Assert
    const written = await readFile(join(repoRoot, 'policy.yaml'), 'utf8')
    expect(written).toContain('# example guidance')
    expect((await loadPolicy(repoRoot)).chain).toEqual(['claude'])
  })

  test('writes built-in defaults when neither policy source exists (plugin install)', async () => {
    // Act — a fresh plugin project has no policy.yaml AND no policy.example.yaml to seed from
    await writePolicyFile(repoRoot, { chain: ['claude'], models: { claude: 'opus' } })

    // Assert
    const policy = await loadPolicy(repoRoot)
    expect(policy.chain).toEqual(['claude'])
    expect(policy.workers.claude.model).toBe('opus')
    expect(policy.maxConcurrentJobs).toBe(2)
  })
})
