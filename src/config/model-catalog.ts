import type { Effort, EngineName } from '../types'

export interface ModelSuggestion {
  readonly id: string
  readonly note?: string
}

// Curated suggestions surfaced by the init flows (interactive configure, delegate-init
// skill). Hints only, never a validation list: any id the vendor CLI accepts stays
// valid, and an empty selection keeps the provider default. Sources: policy.example.yaml
// and the `agy models` listing in docs/PHASE2-RESULTS.md — refresh on vendor releases.
export const MODEL_SUGGESTIONS: Record<EngineName, readonly ModelSuggestion[]> = {
  codex: [{ id: 'gpt-5.6-sol', note: 'general coding default' }],
  claude: [
    { id: 'haiku', note: 'fastest, light tasks' },
    { id: 'sonnet', note: 'balanced default' },
    { id: 'opus', note: 'deepest reasoning' },
  ],
  antigravity: [
    { id: 'gemini-3.5-flash-low', note: 'fastest, light tasks' },
    { id: 'gemini-3.5-flash-medium' },
    { id: 'gemini-3.5-flash-high' },
    { id: 'gemini-3.1-pro-low' },
    { id: 'gemini-3.1-pro-high' },
    { id: 'claude-sonnet-4-6', note: 'balanced default' },
    { id: 'claude-opus-4-6-thinking', note: 'deepest reasoning' },
    { id: 'gpt-oss-120b-medium' },
  ],
}

// Natural light/standard/heavy split per provider, for the optional effort-tier setup.
// Absent engine (codex: one known id) = no preset; tiers stay configurable by hand.
export const TIER_SUGGESTIONS: Partial<
  Record<EngineName, Readonly<Record<Effort, string>>>
> = {
  claude: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
  antigravity: {
    light: 'gemini-3.5-flash-low',
    standard: 'claude-sonnet-4-6',
    heavy: 'claude-opus-4-6-thinking',
  },
}
