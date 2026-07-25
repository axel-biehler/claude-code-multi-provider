import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// A worker CLI invocation split into executable + leading args. Workers are spawned
// WITHOUT a shell (prompts travel as argv), and Windows can only run the .cmd shims
// npm generates through cmd.exe — so npm-package CLIs are invoked as
// `process.execPath <package JS entry>` instead of their node_modules/.bin shim:
// one code path that behaves identically on every platform.
export interface CliCommand {
  readonly command: string
  readonly args: readonly string[]
}

export function cliInvocation(
  cli: CliCommand,
  extraArgs: readonly string[],
): { readonly command: string; readonly args: string[] } {
  return { command: cli.command, args: [...cli.args, ...extraArgs] }
}

export function describeCli(cli: CliCommand): string {
  return [cli.command, ...cli.args].join(' ')
}

// The @openai/codex JS entry — the target of the node_modules/.bin/codex shim.
const CODEX_JS_ENTRY = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'] as const

// Bundled codex first; falls back to a PATH `codex` when the dependency isn't installed.
export async function resolveCodexCli(repoRoot: string): Promise<CliCommand> {
  const jsEntry = join(repoRoot, ...CODEX_JS_ENTRY)
  try {
    await access(jsEntry)
    return { command: process.execPath, args: [jsEntry] }
  } catch {
    return { command: 'codex', args: [] }
  }
}

export async function resolveKimiBin(): Promise<string> {
  const localPath = join(homedir(), '.kimi-code', 'bin', 'kimi')
  try {
    await access(localPath)
    return localPath
  } catch {
    return 'kimi'
  }
}
