import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { DelegateTaskSchema } from '../src/types'
import type { DelegateTask } from '../src/types'

// Every tool call is fast now (delegate_task returns a job_id immediately);
// the long wait lives in the poll loop, bounded by E2E_DEADLINE_MS.
const CALL_TOOL_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 5_000
const E2E_DEADLINE_MS = 900_000

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed'])

interface DelegateCallResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly isError?: boolean
}

// callTool's declared return type is a union with a legacy `toolResult`-only shape, and both
// arms carry a `[x: string]: unknown` index signature — that defeats `in`-based narrowing, so
// `.content` resolves to `unknown` however the union is checked. A runtime-checked type guard
// sidesteps that and gives us a properly typed `content` array to work with.
function isDelegateCallResult(value: unknown): value is DelegateCallResult {
  if (typeof value !== 'object' || value === null) return false
  return Array.isArray((value as { content?: unknown }).content)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function resolveServerCommand(repoRoot: string): Promise<{ command: string; args: string[] }> {
  // Escape hatch to smoke-test the built plugin bundle, e.g.
  // DELEGATE_SERVER_CMD="node plugin/bin/delegate-server.mjs".
  const override = process.env.DELEGATE_SERVER_CMD?.trim()
  if (override) {
    const [command, ...args] = override.split(/\s+/)
    return { command: command ?? 'node', args }
  }
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx')
  try {
    await access(tsxBin)
    return { command: tsxBin, args: ['src/server.ts'] }
  } catch {
    return { command: 'npx', args: ['tsx', 'src/server.ts'] }
  }
}

async function connectClient(repoRoot: string): Promise<Client> {
  const { command, args } = await resolveServerCommand(repoRoot)
  // Forward the parent env (minus undefined values): workers need the full user env
  // (PATH/HOME → CLI auth/keychain) — the SDK otherwise passes a minimal sanitized env.
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const transport = new StdioClientTransport({ command, args, cwd: repoRoot, env })
  const client = new Client({ name: 'delegate-e2e', version: '0.1.0' })
  await client.connect(transport)
  return client
}

async function printToolList(client: Client): Promise<void> {
  const { tools } = await client.listTools()
  const summary = tools.map((tool) => ({
    name: tool.name,
    inputSchemaKeys: Object.keys(tool.inputSchema.properties ?? {}),
  }))
  console.log(JSON.stringify(summary))
}

// Fail fast in the harness with a clear message instead of relying on server-side rejection.
async function loadTask(taskPath: string): Promise<DelegateTask> {
  let raw: string
  try {
    raw = await readFile(taskPath, 'utf8')
  } catch (error) {
    console.error(`Cannot read task file ${taskPath}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error(`Task file ${taskPath} is not valid JSON.`)
    process.exit(2)
  }

  const validated = DelegateTaskSchema.safeParse(parsed)
  if (!validated.success) {
    console.error(`Task file ${taskPath} failed validation: ${validated.error.message}`)
    process.exit(2)
  }
  return validated.data
}

function extractText(result: DelegateCallResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter((line) => line.length > 0)
    .join('\n')
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<DelegateCallResult> {
  const result = await client.callTool(
    { name, arguments: args },
    CallToolResultSchema,
    { timeout: CALL_TOOL_TIMEOUT_MS },
  )
  if (!isDelegateCallResult(result)) {
    throw new Error(`Tool ${name} returned an unexpected result shape (no content array).`)
  }
  return result
}

interface JobRef {
  readonly job_id: string
  readonly status: string
}

function isJobRef(value: unknown): value is JobRef {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as { job_id?: unknown; status?: unknown }
  return typeof ref.job_id === 'string' && typeof ref.status === 'string'
}

function parseJobRef(text: string): JobRef {
  const parsed: unknown = JSON.parse(text)
  if (!isJobRef(parsed)) throw new Error(`Unexpected delegate_task reply: ${text}`)
  return parsed
}

function parseJobList(text: string): readonly JobRef[] {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Unexpected check_delegations reply (expected an object with a jobs array): ${text}`)
  }
  const jobs = (parsed as { jobs?: unknown }).jobs
  if (!Array.isArray(jobs)) {
    throw new Error(`Unexpected check_delegations reply (expected an object with a jobs array): ${text}`)
  }
  return jobs.filter(isJobRef)
}

async function pollUntilDone(client: Client, jobId: string, initialStatus: string): Promise<void> {
  const deadline = Date.now() + E2E_DEADLINE_MS
  let lastStatus = initialStatus

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const listed = await callTool(client, 'check_delegations', {})
    const job = parseJobList(extractText(listed)).find((entry) => entry.job_id === jobId)
    if (job === undefined) continue

    if (job.status !== lastStatus) {
      console.log(`status: ${job.status}`)
      lastStatus = job.status
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      const outcome = await callTool(client, 'get_delegation_result', { job_id: jobId })
      console.log(extractText(outcome))
      await client.close()
      process.exit(outcome.isError ? 1 : 0)
    }
  }

  console.error(`e2e: job ${jobId} did not reach a terminal status within ${E2E_DEADLINE_MS}ms`)
  await client.close()
  process.exit(2)
}

async function main(): Promise<void> {
  if (process.argv.includes('--list-only')) {
    const client = await connectClient(process.cwd())
    await printToolList(client)
    await client.close()
    process.exit(0)
  }

  const taskPath = process.argv[2]
  if (!taskPath) {
    console.error('Usage: tsx scripts/e2e.ts <path-to-task.json> | --list-only')
    process.exit(2)
  }

  const task = await loadTask(taskPath)
  const client = await connectClient(process.cwd())

  try {
    const submitted = await callTool(client, 'delegate_task', { ...task })
    if (submitted.isError) {
      console.error(extractText(submitted))
      await client.close()
      process.exit(1)
    }

    const { job_id, status } = parseJobRef(extractText(submitted))
    console.log(`delegated: job_id=${job_id} status=${status}`)

    await pollUntilDone(client, job_id, status)
  } catch (error) {
    // Happy paths close+exit inside pollUntilDone; this covers parse/transport throws.
    await client.close().catch(() => {})
    throw error
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
