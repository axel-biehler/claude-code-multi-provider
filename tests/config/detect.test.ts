import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  detectAuthenticatedProvider,
  detectAuthenticatedProviders,
} from '../../src/config/detect'

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
}

// The bundled codex is invoked as `process.execPath <JS entry>` — the fixture is a
// plain Node script, no shell involved.
async function writeBundledCodex(repoRoot: string, body: string): Promise<string> {
  const entryDirectory = join(repoRoot, 'node_modules', '@openai', 'codex', 'bin')
  await mkdir(entryDirectory, { recursive: true })
  const entryPath = join(entryDirectory, 'codex.js')
  await writeFile(entryPath, `${body}\n`, 'utf8')
  return entryPath
}

describe('provider authentication detection', () => {
  let repoRoot: string
  let pathDirectory: string
  let originalHome: string | undefined
  let originalPath: string | undefined

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'delegate-detect-'))
    pathDirectory = join(repoRoot, 'path-bin')
    await mkdir(pathDirectory)
    originalHome = process.env.HOME
    originalPath = process.env.PATH
    process.env.HOME = repoRoot
    process.env.PATH = [pathDirectory, '/usr/bin', '/bin'].join(delimiter)
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(repoRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  test('returns both authenticated providers without writing to stdout', async () => {
    // Arrange
    const bundledCodex = await writeBundledCodex(
      repoRoot,
      'process.exit(process.argv[2] === "login" && process.argv[3] === "status" ? 0 : 1)',
    )
    await writeExecutable(
      join(pathDirectory, 'claude'),
      '[ "$1" = "--version" ] && printf "Claude Code 1.2.3\\n"',
    )
    await writeExecutable(
      join(pathDirectory, 'agy'),
      '[ "$1" = "--version" ] && printf "Antigravity 2.3.4\\n"',
    )
    await writeExecutable(
      join(pathDirectory, 'kimi'),
      '[ "$1" = "--version" ] && printf "Kimi Code 0.29.1\\n"',
    )
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    // Act
    const detections = await detectAuthenticatedProviders(repoRoot)

    // Assert
    expect(Object.keys(detections).sort()).toEqual(['antigravity', 'claude', 'codex', 'kimi'])
    expect(detections.codex).toEqual({
      available: true,
      detail: `binary: ${process.execPath} ${bundledCodex}`,
    })
    expect(detections.claude.available).toBe(true)
    expect(detections.claude.detail).toContain('Claude Code 1.2.3')
    expect(detections.claude.detail).toContain(
      'authentication is verified when the first delegated job runs',
    )
    expect(detections.antigravity.available).toBe(true)
    expect(detections.antigravity.detail).toContain('Antigravity 2.3.4')
    expect(detections.antigravity.detail).toContain(
      'authentication is verified when the first delegated job runs',
    )
    expect(detections.kimi.available).toBe(true)
    expect(detections.kimi.detail).toContain('Kimi Code 0.29.1')
    expect(detections.kimi.detail).toContain(
      'authentication is verified when the first delegated job runs',
    )
    expect(stdout).not.toHaveBeenCalled()
  })

  test('keeps the preflight report messages for an unauthenticated bundled codex', async () => {
    // Arrange
    const bundledCodex = await writeBundledCodex(repoRoot, 'process.exit(1)')

    // Act
    const detection = await detectAuthenticatedProvider('codex', repoRoot)

    // Assert
    expect(detection.available).toBe(false)
    expect(detection.detail).toBe('not authenticated — run: codex login')
    expect(detection.reports).toEqual([
      { status: 'ok', message: `codex binary: ${process.execPath} ${bundledCodex}` },
      { status: 'fail', message: 'codex not authenticated — run: codex login' },
    ])
  })

  test('reports missing CLIs without attempting a Claude token check', async () => {
    // Arrange
    process.env.PATH = pathDirectory

    // Act
    const codex = await detectAuthenticatedProvider('codex', repoRoot)
    const claude = await detectAuthenticatedProvider('claude', repoRoot)
    const antigravity = await detectAuthenticatedProvider('antigravity', repoRoot)
    const kimi = await detectAuthenticatedProvider('kimi', repoRoot)

    // Assert
    expect(codex.available).toBe(false)
    expect(codex.detail).toBe(
      'CLI not found on PATH — install: npm i -g @openai/codex && codex login',
    )
    expect(codex.reports).toEqual([
      {
        status: 'fail',
        message:
          'codex CLI not found on PATH — install: npm i -g @openai/codex && codex login',
      },
    ])
    expect(claude.available).toBe(false)
    expect(claude.detail).toBe('CLI not found on PATH — install the Claude Code CLI')
    expect(claude.reports).toEqual([
      { status: 'fail', message: 'claude CLI not found on PATH — install the Claude Code CLI' },
    ])
    expect(antigravity.available).toBe(false)
    expect(antigravity.detail).toBe(
      'agy CLI not found on PATH — install the Antigravity CLI',
    )
    expect(antigravity.reports).toEqual([
      {
        status: 'fail',
        message: 'agy CLI not found on PATH — install the Antigravity CLI',
      },
    ])
    expect(kimi.available).toBe(false)
    expect(kimi.detail).toBe(
      'kimi CLI not found — install Kimi Code CLI (https://code.kimi.com) and run: kimi login',
    )
    expect(kimi.reports).toEqual([
      {
        status: 'fail',
        message:
          'kimi CLI not found — install Kimi Code CLI (https://code.kimi.com) and run: kimi login',
      },
    ])
  })
})
