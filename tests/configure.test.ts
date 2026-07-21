import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  buildPolicyPatch,
  ensureDefaultPolicy,
  parseProviderSelection,
} from '../scripts/configure'

describe('parseProviderSelection', () => {
  test('preserves the chosen provider order', () => {
    // Act
    const chain = parseProviderSelection('claude, codex', ['codex', 'claude'])

    // Assert
    expect(chain).toEqual(['claude', 'codex'])
  })

  test('uses every available provider when the answer is blank', () => {
    // Act
    const chain = parseProviderSelection('  ', ['claude', 'antigravity'])

    // Assert
    expect(chain).toEqual(['claude', 'antigravity'])
  })

  test('rejects unavailable and duplicate providers', () => {
    // Act
    const unavailable = () => parseProviderSelection('codex', ['claude'])
    const duplicate = () => parseProviderSelection('claude claude', ['claude'])

    // Assert
    expect(unavailable).toThrow('codex is not available')
    expect(duplicate).toThrow('claude was selected more than once')
  })
})

describe('buildPolicyPatch', () => {
  test('omits a blank codex model and defaults a blank claude model to sonnet', () => {
    // Act
    const patch = buildPolicyPatch(['codex', 'claude', 'antigravity'], {
      codex: '  ',
      claude: '',
      antigravity: ' ',
    })

    // Assert
    expect(patch).toEqual({
      chain: ['codex', 'claude', 'antigravity'],
      models: { claude: 'sonnet' },
    })
  })

  test('trims explicit model names', () => {
    // Act
    const patch = buildPolicyPatch(['claude', 'codex', 'antigravity'], {
      codex: ' gpt-test ',
      claude: ' opus ',
      antigravity: ' gemini-test ',
    })

    // Assert
    expect(patch).toEqual({
      chain: ['claude', 'codex', 'antigravity'],
      models: { claude: 'opus', codex: 'gpt-test', antigravity: 'gemini-test' },
    })
  })
})

describe('ensureDefaultPolicy', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-configure-'))
    await writeFile(join(repoRoot, 'policy.example.yaml'), 'chain: [codex, claude]\n', 'utf8')
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('copies the example when policy.yaml is absent', async () => {
    // Act
    const created = await ensureDefaultPolicy(repoRoot)

    // Assert
    expect(created).toBe(true)
    expect(await readFile(join(repoRoot, 'policy.yaml'), 'utf8')).toBe(
      'chain: [codex, claude]\n',
    )
  })

  test('leaves an existing policy byte-identical', async () => {
    // Arrange
    const current = 'workers:\n  codex:\n    timeoutMs: 1200000\n'
    await writeFile(join(repoRoot, 'policy.yaml'), current, 'utf8')

    // Act
    const created = await ensureDefaultPolicy(repoRoot)

    // Assert
    expect(created).toBe(false)
    expect(await readFile(join(repoRoot, 'policy.yaml'), 'utf8')).toBe(current)
  })
})
