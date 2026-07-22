import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  cliInvocation,
  describeCli,
  resolveCodexCli,
} from '../../../src/engines/shared/cli-command'

describe('resolveCodexCli', () => {
  let repoRoot: string

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-cli-command-'))
  })

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  test('runs the bundled JS entry through the current node when installed', async () => {
    // Arrange
    const entryDirectory = join(repoRoot, 'node_modules', '@openai', 'codex', 'bin')
    await mkdir(entryDirectory, { recursive: true })
    await writeFile(join(entryDirectory, 'codex.js'), 'process.exit(0)\n', 'utf8')

    // Act
    const cli = await resolveCodexCli(repoRoot)

    // Assert
    expect(cli).toEqual({
      command: process.execPath,
      args: [join(entryDirectory, 'codex.js')],
    })
  })

  test('falls back to a PATH codex when the dependency is not installed', async () => {
    // Act
    const cli = await resolveCodexCli(repoRoot)

    // Assert
    expect(cli).toEqual({ command: 'codex', args: [] })
  })
})

describe('cliInvocation', () => {
  test('appends invocation args after the CLI leading args', () => {
    // Arrange
    const cli = { command: '/usr/local/bin/node', args: ['/repo/codex.js'] }

    // Act
    const invocation = cliInvocation(cli, ['login', 'status'])

    // Assert
    expect(invocation).toEqual({
      command: '/usr/local/bin/node',
      args: ['/repo/codex.js', 'login', 'status'],
    })
  })
})

describe('describeCli', () => {
  test('renders a bare PATH command without trailing space', () => {
    expect(describeCli({ command: 'codex', args: [] })).toBe('codex')
  })

  test('renders command and leading args as one readable line', () => {
    expect(describeCli({ command: '/bin/node', args: ['/repo/codex.js'] })).toBe(
      '/bin/node /repo/codex.js',
    )
  })
})
