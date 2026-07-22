---
name: delegate-init
description: Use this skill when delegation routing needs initial configuration or an update. Provider-neutral by design: detect available providers, let the user choose their order and models, then write the shared policy through tools.
---

# Delegate Init

Configure delegation routing through the MCP tool. Treat provider identifiers and model
suggestions returned by the tool as data, and do not favor, infer, or silently add a
provider or model.

## Playbook

1. Call `configure_delegation({ action: "detect" })` to inspect local provider
   availability, each provider's model suggestions (`suggestedModels`, `suggestedTiers`),
   and the current policy. This is a local configuration check and does not delegate
   work or spend an LLM call.
2. Use `AskUserQuestion` to ask which available provider or providers to enable and
   their order in the routing chain. Offer **only** entries whose returned `available`
   value is `true`. Preserve the user's exact order; never include an unavailable or
   unselected provider. If none are available, explain that configuration cannot
   proceed until at least one provider is available, and stop.
3. For each selected provider, ask which model to use with `AskUserQuestion`: offer that
   provider's `suggestedModels` (use the returned notes as descriptions; mark the current
   policy value when one exists) plus a "Provider default" option. Suggestions are hints,
   not a validation list — a custom id typed via "Other" is always valid.
4. Offer optional per-effort model tiers (`light` | `standard` | `heavy`). When the user
   wants them for a provider, start from that provider's `suggestedTiers` and let the
   user adjust each tier. `delegate_task`'s engine-neutral `effort` hint selects the tier
   at job time; an unset tier falls back to the provider's base model.
5. Call `configure_delegation({ action: "write", chain, models })` with the ordered
   chain and model mapping. Per provider, the model value is either a scalar id or a
   `{ light, standard, heavy }` tier map — when the user configured tiers, send the tier
   map and make sure `standard` is set (it covers the base-model role). Drive this
   workflow with the tool, not shell commands or direct edits to `policy.yaml`.
6. Confirm the chain, models, and tiers returned by the write action. Mention
   `npm run preflight` as the follow-up command for a live authentication check.

Keep all guidance provider-neutral. Provider and model names may be repeated only as
values returned by the tool or selected by the user.
