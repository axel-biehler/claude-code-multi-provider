import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { executeJob } from './jobs/executor'
import { JobStore } from './jobs/store'
import { registerDelegateTools } from './mcp/tools'
import { loadPolicy } from './routing/policy'
import { QuotaLedger } from './routing/quota'

const execFileAsync = promisify(execFile)

async function main(): Promise<void> {
  const bootedAt = Date.now()
  // When launched as a Claude Code plugin the cwd is the plugin's install dir, not the
  // user's project — CLAUDE_PROJECT_DIR points at the repo we must operate on. Falls back
  // to cwd for the project-scoped .mcp.json / e2e cases where the two already coincide.
  const repoRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  let gitRev = 'unknown'
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
    gitRev = stdout.trim() || 'unknown'
  } catch {
    // Git metadata is diagnostic only and must never prevent the server from starting.
  }
  const serverInfo = { bootedAt, gitRev }
  // A malformed policy.yaml throws → fatal exit below: the user must know their policy was NOT applied.
  const policy = await loadPolicy(repoRoot)
  const ledger = await QuotaLedger.load(repoRoot)
  const store = new JobStore({
    repoRoot,
    policy,
    execute: (jobId, task, revision) =>
      executeJob({ repoRoot, policy, ledger }, jobId, task, revision),
  })

  const server = new McpServer({ name: 'delegate', version: '0.1.0' })
  registerDelegateTools(server, store, serverInfo, repoRoot)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(
    `[delegate] server ready — rev=${gitRev} booted=${new Date(bootedAt).toISOString()} chain=${policy.chain.join('>')} maxConcurrentJobs=${policy.maxConcurrentJobs}`,
  )
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error('[delegate] fatal:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
