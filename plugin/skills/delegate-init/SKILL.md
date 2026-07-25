---
name: delegate-init
description: Use this skill when delegation routing needs initial configuration or an update. Provider-neutral by design: detect available providers, let the user choose their order and models, then write the shared policy through tools.
---

# Delegate Init

Configure delegation routing through the MCP tool. Treat provider identifiers returned by
the tool as data, and do not favor, infer, or silently add a provider.

## Playbook

1. Call `configure_delegation({ action: "detect" })`. This is a local check: it neither
   delegates work nor spends an LLM call. Use the top-level `currentPolicy` to show the
   existing configuration and seed defaults. Use these exact fields for each provider:
   - `available`: boolean eligibility for the chain.
   - `detail`: status or why the provider is unavailable, including any remedy; relay it
     verbatim.
   - `models`: ordered newest-first array of `{ id, recommended? }` entries.
   - `modelsSource`: `'cli'` when this machine's provider CLI live-listed the models, or
     `'catalog'` for a curated fallback that may lag behind reality.
   - `defaultModel`: the locally configured default when it can be discovered.
2. Use `AskUserQuestion` to select the chain. Include this explanation in the question
   text: "The chain is a priority order: the provider in position 1 receives every
   delegated job; later entries are automatic fallbacks used only when an earlier provider
   hits a quota or authentication wall." Offer only providers with `available: true`, and
   preserve the user's exact order. Show each unavailable provider's `detail` verbatim
   instead of inventing a remedy. If none are available, relay their details and stop.
3. For each selected provider, use `AskUserQuestion` to choose its model. Build options
   from that provider's `models`: put the `recommended` entry first, then keep the remaining
   payload order (newest first). When `defaultModel` is present, identify its matching
   option as the locally configured default, or mention it separately if it is not listed.
   If `modelsSource` is `'catalog'`, say the list is indicative and may lag behind reality,
   and that any model id can be typed through the Other option.
4. Configure the three effort tiers — this is the recommended path, not an afterthought.
   `delegate_task` picks a tier (`light`/`standard`/`heavy`) per subtask, so a complete
   policy defines all three for both axes:
   - **Models**: offer per-tier models with `AskUserQuestion` (options built as in step 3);
     tiered choices write `models: { <provider>: { light, standard, heavy } }`. A single
     model for every tier is an acceptable simpler answer only if the user explicitly
     prefers it.
   - **Reasoning**: offer per-tier reasoning too, defaulting to `light` → `low`,
     `standard` → `medium`, `heavy` → the provider's highest supported tier (see the
     Configuration reference for each provider's values). Present those defaults as the
     recommended selection the user can accept in one step or adjust per tier.
   Only skip a tier when the user declines it; never silently drop to a single scalar.
5. Call `configure_delegation({ action: "write", chain, models, reasoning })` with all three
   tiers you gathered, then confirm the chain, models, and reasoning returned by the write
   action — call out any tier left unset. State that live authentication is verified when the
   first delegated job runs. Never run package scripts or shell commands in the user's
   project during this flow.

Keep all user-facing guidance provider-neutral. Outside the configuration reference,
provider names may be repeated only as values returned by the tool or selected by the user.

## Configuration reference

`workers.<provider>.reasoning` accepts a scalar or per-effort map and can be written through
`configure_delegation` or by editing `policy.yaml`. Values and the recommended
`light`/`standard`/`heavy` mapping per provider:

- Codex — `minimal`/`low`/`medium`/`high`/`xhigh`; recommended `low`/`medium`/`xhigh`.
- Claude — `low`/`medium`/`high`/`xhigh`/`max`; recommended `low`/`medium`/`max`.
- Antigravity — `low`/`medium`/`high`; recommended `low`/`medium`/`high`.
- Kimi — no reasoning values (the CLI has no reasoning flag); configure its effort tiers
  through the per-effort `models` map instead.

If absent, the provider default applies and no reasoning flag is passed.
