import { describe, expect, test } from 'vitest'
import { MODEL_SUGGESTIONS, TIER_SUGGESTIONS } from '../../src/config/model-catalog'
import type { EngineName } from '../../src/types'

const ENGINES: readonly EngineName[] = ['codex', 'claude', 'antigravity']

describe('MODEL_SUGGESTIONS', () => {
  test.each(ENGINES)('%s offers at least one suggestion with unique non-empty ids', (engine) => {
    // Act
    const ids = MODEL_SUGGESTIONS[engine].map((suggestion) => suggestion.id)

    // Assert
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.trim().length > 0)).toBe(true)
  })
})

describe('TIER_SUGGESTIONS', () => {
  test('every tier preset references a suggested model of the same provider', () => {
    for (const [engine, tiers] of Object.entries(TIER_SUGGESTIONS)) {
      const ids = MODEL_SUGGESTIONS[engine as EngineName].map((suggestion) => suggestion.id)
      for (const model of Object.values(tiers)) {
        expect(ids).toContain(model)
      }
    }
  })

  test('presets cover the three effort tiers', () => {
    for (const tiers of Object.values(TIER_SUGGESTIONS)) {
      expect(Object.keys(tiers).sort()).toEqual(['heavy', 'light', 'standard'])
    }
  })
})
