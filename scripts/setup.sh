#!/usr/bin/env bash
# Quick install for the delegate MCP server. Idempotent — safe to re-run.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "[setup] delegate MCP — quick install"

# 1) Node >= 20 (the stdio MCP server and tsx require it).
if ! command -v node >/dev/null 2>&1; then
  echo "[setup] FAIL: node not found — install Node.js >= 20 first." >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 20 ]; then
  echo "[setup] FAIL: node $(node -v) is too old — need >= 20." >&2
  exit 1
fi
echo "[setup] node $(node -v) ok"

# 2) Dependencies (public registry pinned in .npmrc; bundles the codex worker CLI).
echo "[setup] installing dependencies…"
npm install

# 3) Interactive setup can tailor routing; automation keeps the copy-only behavior.
if [ -t 0 ]; then
  npm run configure
elif [ -f policy.yaml ]; then
  echo "[setup] policy.yaml already present — keeping it"
else
  cp policy.example.yaml policy.yaml
  echo "[setup] policy.yaml created from policy.example.yaml"
fi

# 4) Static gate (no live requests, no spend). Reports codex auth status.
echo "[setup] running static preflight…"
npm run preflight -- --no-probe || true

# 5) What's left for the human.
cat <<'EOF'

[setup] done. Next steps:
  1. If preflight flagged the codex worker as unauthenticated:  npm run codex-login
  2. Verify live (real quota/token probe, small spend):         npm run preflight
  3. Open this repo in Claude Code — the `delegate` MCP server is auto-registered
     via .mcp.json. Confirm with /mcp, then use delegate_task / check_delegations
     / get_delegation_result.
EOF
