import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  buildPolicyPatch,
  buildTierPatch,
  ensureDefaultPolicy,
  formatModelMenu,
  parseModelChoice,
  parseProviderSelection,
  parseTierChoice,
} from '../scripts/configure'
import { MODEL_SUGGESTIONS } from '../src/config/model-catalog'

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

describe('parseModelChoice', () => {
  const suggestions = [{ id: 'model-one', note: 'fast' }, { id: 'model-two' }]

  test('maps a menu number to the suggested id', () => {
    expect(parseModelChoice('2', suggestions)).toBe('model-two')
  })

  test('keeps a free-form id verbatim (trimmed)', () => {
    expect(parseModelChoice('  custom-model ', suggestions)).toBe('custom-model')
  })

  test('returns empty for a blank answer (provider default)', () => {
    expect(parseModelChoice('   ', suggestions)).toBe('')
  })

  test('rejects an out-of-range menu number', () => {
    expect(() => parseModelChoice('7', suggestions)).toThrow('No suggestion #7')
  })
})

describe('parseTierChoice', () => {
  const suggestions = [{ id: 'model-one' }]

  test('falls back to the suggested tier default on a blank answer', () => {
    expect(parseTierChoice('', suggestions, 'model-one')).toBe('model-one')
  })

  test('returns undefined on a blank answer without a suggested default', () => {
    expect(parseTierChoice('', suggestions, undefined)).toBeUndefined()
  })

  test('accepts menu numbers and free-form ids like the base model question', () => {
    expect(parseTierChoice('1', suggestions, undefined)).toBe('model-one')
    expect(parseTierChoice('other', suggestions, 'model-one')).toBe('other')
  })
})

describe('buildTierPatch', () => {
  test('returns null when no provider configured any tier', () => {
    expect(buildTierPatch({})).toBeNull()
    expect(buildTierPatch({ codex: {} })).toBeNull()
  })

  test('keeps only the configured tiers per provider', () => {
    // Act
    const patch = buildTierPatch({
      claude: { light: 'haiku', heavy: 'opus' },
      codex: {},
    })

    // Assert
    expect(patch).toEqual({ models: { claude: { light: 'haiku', heavy: 'opus' } } })
  })
})

describe('formatModelMenu', () => {
  test('lists every suggestion numbered, with notes when present', () => {
    // Act
    const lines = formatModelMenu('claude')

    // Assert
    expect(lines[0]).toContain('claude')
    expect(lines.length).toBe(MODEL_SUGGESTIONS.claude.length + 1)
    expect(lines[1]).toContain('1. haiku')
    expect(lines[1]).toContain('fastest')
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
