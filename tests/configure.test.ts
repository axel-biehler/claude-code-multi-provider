import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { writePolicyFile } from '../src/config/policy-writer'
import { PolicySchema } from '../src/routing/policy'
import {
  buildPolicyPatch,
  ensureDefaultPolicy,
  formatModelMenu,
  parseProviderSelection,
  resolveModelAnswer,
  resolveReasoningAnswer,
  supportsReasoningConfiguration,
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
    const chain = parseProviderSelection('  ', ['claude', 'antigravity', 'kimi', 'mammouth'])

    // Assert
    expect(chain).toEqual(['claude', 'antigravity', 'kimi', 'mammouth'])
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
    const patch = buildPolicyPatch(['codex', 'claude', 'antigravity', 'mammouth'], {
      codex: '  ',
      claude: '',
      antigravity: ' ',
      mammouth: ' ',
    })

    // Assert
    expect(patch).toEqual({
      chain: ['codex', 'claude', 'antigravity', 'mammouth'],
      models: { claude: 'sonnet' },
    })
  })

  test('trims explicit model names', () => {
    // Act
    const patch = buildPolicyPatch(['claude', 'codex', 'antigravity', 'mammouth'], {
      codex: ' gpt-test ',
      claude: ' opus ',
      antigravity: ' gemini-test ',
      mammouth: ' opencode/big-pickle ',
    })

    // Assert
    expect(patch).toEqual({
      chain: ['claude', 'codex', 'antigravity', 'mammouth'],
      models: {
        claude: 'opus',
        codex: 'gpt-test',
        antigravity: 'gemini-test',
        mammouth: 'opencode/big-pickle',
      },
    })
  })

  test('writes only answered per-effort tiers while preserving scalar providers', () => {
    // Act
    const patch = buildPolicyPatch(
      ['codex', 'claude', 'antigravity'],
      {
        codex: 'gpt-test',
        claude: '',
        antigravity: 'gemini-default',
      },
      {
        codex: { light: ' gpt-light ', standard: '', heavy: 'gpt-heavy' },
        claude: { light: '', standard: ' ', heavy: '' },
      },
    )

    // Assert
    expect(patch).toEqual({
      chain: ['codex', 'claude', 'antigravity'],
      models: {
        codex: { light: 'gpt-light', heavy: 'gpt-heavy' },
        claude: 'sonnet',
        antigravity: 'gemini-default',
      },
    })
  })

  test('omits the reasoning key entirely when no reasoning tier is answered', () => {
    // Act
    const patch = buildPolicyPatch(['codex', 'claude'], { codex: 'gpt-test', claude: '' })

    // Assert
    expect(patch).not.toHaveProperty('reasoning')
  })

  test('writes only answered per-effort reasoning tiers', () => {
    // Act
    const patch = buildPolicyPatch(
      ['codex', 'claude', 'antigravity'],
      { codex: 'gpt-test', claude: '', antigravity: 'gemini-default' },
      {},
      {
        codex: { light: ' low ', standard: '', heavy: 'xhigh' },
        claude: { light: '', standard: ' ', heavy: '' },
      },
    )

    // Assert
    expect(patch).toEqual({
      chain: ['codex', 'claude', 'antigravity'],
      models: { codex: 'gpt-test', claude: 'sonnet', antigravity: 'gemini-default' },
      reasoning: { codex: { light: 'low', heavy: 'xhigh' } },
    })
  })

  test('emits both model tiers and reasoning tiers together', () => {
    // Act
    const patch = buildPolicyPatch(
      ['codex', 'claude'],
      { codex: '', claude: '' },
      { codex: { light: 'gpt-light', standard: '', heavy: '' } },
      { codex: { light: 'low', standard: '', heavy: '' }, claude: { standard: 'medium' } },
    )

    // Assert
    expect(patch).toEqual({
      chain: ['codex', 'claude'],
      models: { codex: { light: 'gpt-light' }, claude: 'sonnet' },
      reasoning: { codex: { light: 'low' }, claude: { standard: 'medium' } },
    })
  })
})

describe('resolveModelAnswer', () => {
  const models = [{ id: 'newest' }, { id: 'older' }] as const

  test('resolves a numbered choice to the matching model id', () => {
    expect(resolveModelAnswer('2', models)).toBe('older')
  })

  test('rejects non-positive and out-of-range numbered choices', () => {
    expect(() => resolveModelAnswer('0', models)).toThrow('Model number must be between 1 and 2')
    expect(() => resolveModelAnswer('-1', models)).toThrow('Model number must be between 1 and 2')
    expect(() => resolveModelAnswer('3', models)).toThrow('Model number must be between 1 and 2')
  })

  test('passes a literal model id through verbatim', () => {
    expect(resolveModelAnswer(' custom-model ', models)).toBe(' custom-model ')
  })

  test('passes an empty answer through', () => {
    expect(resolveModelAnswer('', models)).toBe('')
  })
})

describe('resolveReasoningAnswer', () => {
  test('returns a value valid for the given engine', () => {
    expect(resolveReasoningAnswer(' xhigh ', 'codex')).toBe('xhigh')
    expect(resolveReasoningAnswer(' max ', 'claude')).toBe('max')
    expect(resolveReasoningAnswer(' high ', 'antigravity')).toBe('high')
    expect(resolveReasoningAnswer(' max ', 'mammouth')).toBe('max')
  })

  test('returns an empty string for a blank answer', () => {
    expect(resolveReasoningAnswer('   ', 'codex')).toBe('')
  })

  test('skips reasoning configuration for kimi', () => {
    expect(supportsReasoningConfiguration('kimi')).toBe(false)
    expect(supportsReasoningConfiguration('codex')).toBe(true)
  })

  test('throws for a value invalid for the given engine, listing the allowed set', () => {
    expect(() => resolveReasoningAnswer('max', 'codex')).toThrow(
      'Reasoning must be one of: minimal, low, medium, high, xhigh',
    )
    expect(() => resolveReasoningAnswer('minimal', 'claude')).toThrow(
      'Reasoning must be one of: low, medium, high, xhigh, max',
    )
    expect(() => resolveReasoningAnswer('xhigh', 'antigravity')).toThrow(
      'Reasoning must be one of: low, medium, high',
    )
    expect(() => resolveReasoningAnswer('xhigh', 'mammouth')).toThrow(
      'Reasoning must be one of: minimal, low, medium, high, max',
    )
  })
})

describe('formatModelMenu', () => {
  test('preserves newest-first payload order and marks recommended and local defaults', () => {
    // Act
    const lines = formatModelMenu('codex', {
      models: [
        { id: 'newest', recommended: true },
        { id: 'local' },
        { id: 'oldest' },
      ],
      source: 'cli',
      defaultModel: 'local',
    })

    // Assert
    expect(lines).toEqual([
      'codex models (newest first):',
      '  1. newest (recommended)',
      '  2. local (local default)',
      '  3. oldest',
    ])
  })

  test('can apply both markers to one model and adds the catalog caveat', () => {
    // Act
    const lines = formatModelMenu('claude', {
      models: [{ id: 'sonnet', recommended: true }],
      source: 'catalog',
      defaultModel: 'sonnet',
    })

    // Assert
    expect(lines).toEqual([
      'claude models (newest first):',
      '  1. sonnet (recommended) (local default)',
      '  Catalog list is indicative; you can type any model id.',
    ])
  })

  test('returns no menu for an empty model list', () => {
    expect(formatModelMenu('codex', { models: [], source: 'catalog' })).toEqual([])
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

describe('buildPolicyPatch reasoning round-trip', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-configure-reasoning-'))
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('writing the patch through writePolicyFile keeps the reasoning tiers', async () => {
    // Arrange
    const patch = buildPolicyPatch(
      ['codex', 'claude'],
      { codex: 'gpt-test', claude: '' },
      {},
      { codex: { light: 'low', heavy: 'xhigh' }, claude: { standard: 'medium' } },
    )

    // Act
    await writePolicyFile(repoRoot, patch)
    const written = await readFile(join(repoRoot, 'policy.yaml'), 'utf8')
    const policy = PolicySchema.parse(parse(written))

    // Assert
    expect(policy.workers.codex.reasoning).toEqual({ light: 'low', heavy: 'xhigh' })
    expect(policy.workers.claude.reasoning).toEqual({ standard: 'medium' })
  })
})
