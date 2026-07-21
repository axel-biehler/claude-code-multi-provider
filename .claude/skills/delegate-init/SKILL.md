---
name: delegate-init
description: Use this skill when delegation routing needs initial configuration or an update. Provider-neutral by design: detect available providers, let the user choose their order and models, then write the shared policy through tools.
---

# Delegate Init

Configure delegation routing through the MCP tool. Treat provider identifiers returned by
the tool as data, and do not favor, infer, or silently add a provider.

## Playbook

1. Call `configure_delegation({ action: "detect" })` to inspect local provider
   availability and the current policy. This is a local configuration check and does not
   delegate work or spend an LLM call.
2. Use `AskUserQuestion` to ask which available provider or providers to enable, their
   order in the routing chain, and the model for each selected provider. Offer **only**
   entries whose returned `available` value is `true`. Preserve the user's exact order;
   never include an unavailable or unselected provider. If none are available, explain
   that configuration cannot proceed until at least one provider is available, and stop.
3. Call `configure_delegation({ action: "write", chain, models })` with the selected
   ordered chain and model mapping. Drive this workflow with the tool, not shell commands
   or direct edits to `policy.yaml`.
4. Confirm the chain and models returned by the write action. Mention `npm run preflight`
   as the follow-up command for a live authentication check.

Keep all guidance provider-neutral. Provider names may be repeated only as values returned
by the tool or selected by the user.
