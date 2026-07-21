#!/usr/bin/env bash
# Builds the distributable Claude Code plugin under plugin/ from the dev sources.
# The server is bundled into ONE self-contained ESM file (no node_modules at runtime);
# codex/claude stay external CLIs the plugin user provides. Re-run after touching src/,
# the skills, or the subagent. Commit plugin/ so marketplace installs work without a build.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

esbuild="./node_modules/.bin/esbuild"
if [ ! -x "$esbuild" ]; then
  echo "[build-plugin] FAIL: esbuild not found — run npm install first." >&2
  exit 1
fi

mkdir -p plugin/bin plugin/skills plugin/agents

# 1) Bundle the stdio MCP server into one self-contained ESM file. The createRequire
#    banner shims any runtime require() a bundled CJS dependency performs under ESM.
"$esbuild" src/server.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --outfile=plugin/bin/delegate-server.mjs \
  --banner:js='import{createRequire as __cr}from"module";const require=__cr(import.meta.url);'
echo "[build-plugin] bundled plugin/bin/delegate-server.mjs"

# 2) Copy skills + subagent from the dev sources (.claude/ stays the single source of truth).
for skill_dir in .claude/skills/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  rm -rf "plugin/skills/$skill_name"
  cp -R "$skill_dir" "plugin/skills/$skill_name"
done
cp .claude/agents/delegation-manager.md plugin/agents/delegation-manager.md
echo "[build-plugin] copied skills + subagent"

echo "[build-plugin] done — plugin/ is ready to publish"
