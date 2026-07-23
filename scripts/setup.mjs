#!/usr/bin/env node
// Quick install for the delegate MCP server. Idempotent — safe to re-run.
// Plain Node with zero dependencies: it must run BEFORE `npm install`, and on
// Windows (cmd/PowerShell) as well as macOS/Linux — no bash, no POSIX tools.
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE_MAJOR_MIN = 20
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function log(message) {
  console.log(`[setup] ${message}`)
}

function fail(message) {
  console.error(`[setup] FAIL: ${message}`)
  process.exit(1)
}

// When launched through `npm run`, npm_execpath points at npm's own JS entry —
// running it with the current node avoids PATH lookup entirely. The bare-`npm`
// fallback needs shell resolution on Windows (npm is a .cmd shim there); every
// argument we pass is a constant, so shell mode is injection-safe.
function npmInvocation(args) {
  const npmEntry = process.env.npm_execpath
  if (npmEntry !== undefined && npmEntry !== '') {
    return { command: process.execPath, args: [npmEntry, ...args], shell: false }
  }
  return { command: 'npm', args, shell: process.platform === 'win32' }
}

function runNpm(args) {
  const invocation = npmInvocation(args)
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: invocation.shell,
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise(code ?? -1))
  })
}

async function ensureDefaultPolicy() {
  try {
    await copyFile(
      resolve(repoRoot, 'policy.example.yaml'),
      resolve(repoRoot, 'policy.yaml'),
      constants.COPYFILE_EXCL,
    )
    log('policy.yaml created from policy.example.yaml')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      log('policy.yaml already present — keeping it')
      return
    }
    throw error
  }
}

async function main() {
  log('delegate MCP — quick install')

  // 1) Node >= 20 (the stdio MCP server and tsx require it).
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (Number.isNaN(nodeMajor) || nodeMajor < NODE_MAJOR_MIN) {
    fail(`node ${process.version} is too old — need >= ${NODE_MAJOR_MIN}.`)
  }
  log(`node ${process.version} ok`)

  // 2) Dependencies (public registry pinned in .npmrc; bundles the codex worker CLI).
  log('installing dependencies…')
  if ((await runNpm(['install'])) !== 0) fail('npm install failed.')

  // 3) Interactive setup can tailor routing; automation keeps the copy-only behavior.
  if (process.stdin.isTTY) {
    if ((await runNpm(['run', 'configure'])) !== 0) fail('configure failed.')
  } else {
    await ensureDefaultPolicy()
  }

  // 4) Static gate (no live requests, no spend). Reports worker auth status.
  log('running static preflight…')
  await runNpm(['run', 'preflight', '--', '--no-probe'])

  // 5) What's left for the human.
  console.log(`
[setup] done. Next steps:
  1. If preflight flagged the codex worker as unauthenticated:  npm run codex-login
  2. Verify live (real quota/token probe, small spend):         npm run preflight
  3. Open this repo in Claude Code — the \`delegate\` MCP server is auto-registered
     via .mcp.json. Confirm with /mcp, then use delegate_task / check_delegations
     / get_delegation_result.
`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
