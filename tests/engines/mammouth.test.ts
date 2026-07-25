import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  buildMammouthArgs,
  classifyMammouthFailure,
  parseMammouthEvents,
  resolveMammouthBin,
  runMammouth,
} from '../../src/engines/mammouth'
import { buildJobPaths } from '../../src/jobs/paths'

const baseOptions = {
  mammouthBin: 'mammouth',
  worktreePath: '/tmp/worktree',
  prompt: 'Implement the requested change',
  paths: {
    jobDir: '/tmp/job',
    promptFile: '/tmp/job/prompt.md',
    eventsFile: '/tmp/job/events.json',
    stderrFile: '/tmp/job/stderr.log',
    lastMessageFile: '/tmp/job/last-message.md',
    diffFile: '/tmp/job/diff.patch',
    statusFile: '/tmp/job/status.json',
  },
}

describe('parseMammouthEvents', () => {
  test('extracts the last text event and the last error message', () => {
    // Arrange
    const raw = [
      JSON.stringify({ type: 'text', part: { text: 'first response' } }),
      JSON.stringify({ type: 'error', error: { name: 'FirstError' } }),
      JSON.stringify({ type: 'text', part: { text: 'final response' } }),
      JSON.stringify({
        type: 'error',
        error: { name: 'UnknownError', data: { message: 'Unexpected server error.' } },
      }),
    ].join('\n')

    // Act
    const result = parseMammouthEvents(raw)

    // Assert
    expect(result).toEqual({
      lastMessage: 'final response',
      errorMessage: 'Unexpected server error.',
    })
  })

  test('tolerates blank, malformed, and non-object lines', () => {
    // Arrange
    const raw = [
      '',
      'not json',
      '42',
      'null',
      '[]',
      JSON.stringify({ type: 'text', part: { text: 42 } }),
      JSON.stringify({ type: 'text', part: { text: 'usable' } }),
    ].join('\n')

    // Act
    const result = parseMammouthEvents(raw)

    // Assert
    expect(result).toEqual({ lastMessage: 'usable', errorMessage: null })
  })

  test('returns null fields for empty input', () => {
    expect(parseMammouthEvents('')).toEqual({ lastMessage: null, errorMessage: null })
  })

  test('falls back to the error name when the error data message is unavailable', () => {
    // Arrange
    const raw = JSON.stringify({
      type: 'error',
      error: { name: 'UnknownError', data: { message: 42 } },
    })

    // Act
    const result = parseMammouthEvents(raw)

    // Assert
    expect(result.errorMessage).toBe('UnknownError')
  })
})

describe('classifyMammouthFailure', () => {
  test('returns undefined on exit 0', () => {
    expect(
      classifyMammouthFailure({
        exitCode: 0,
        eventsText: 'rate limit reached',
        stderrText: 'not logged in',
      }),
    ).toBeUndefined()
  })

  test('classifies failure text from events and stderr', () => {
    expect(
      classifyMammouthFailure({
        exitCode: 1,
        eventsText: '{"error":"Rate limit reached"}',
        stderrText: '',
      }),
    ).toBe('quota')
    expect(
      classifyMammouthFailure({
        exitCode: 1,
        eventsText: '',
        stderrText: '401 unauthorized',
      }),
    ).toBe('auth')
    expect(
      classifyMammouthFailure({
        exitCode: 1,
        eventsText: '',
        stderrText: 'plain error',
      }),
    ).toBe('other')
  })
})

describe('buildMammouthArgs', () => {
  test('builds the ordered base arguments with the separator immediately before the prompt', () => {
    // Act
    const args = buildMammouthArgs({ ...baseOptions, prompt: '--version' })

    // Assert
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      '--',
      '--version',
    ])
  })

  test('includes model and reasoning in single-token form when configured', () => {
    // Act
    const args = buildMammouthArgs({
      ...baseOptions,
      model: 'anthropic/claude-sonnet',
      reasoning: 'high',
    })

    // Assert
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--dangerously-skip-permissions',
      '--model=anthropic/claude-sonnet',
      '--variant=high',
      '--',
      'Implement the requested change',
    ])
  })

  test('omits model and variant flags when their options are undefined', () => {
    // Act
    const args = buildMammouthArgs(baseOptions)

    // Assert
    expect(args.some((arg) => arg.startsWith('--model='))).toBe(false)
    expect(args.some((arg) => arg.startsWith('--variant='))).toBe(false)
    expect(args.at(-2)).toBe('--')
    expect(args.at(-1)).toBe(baseOptions.prompt)
  })
})

describe('resolveMammouthBin', () => {
  test('returns the user-local binary when it is accessible', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'delegate-mammouth-home-'))
    const localBin = join(home, '.mammouth', 'bin', 'mammouth')
    await mkdir(join(home, '.mammouth', 'bin'), { recursive: true })
    await writeFile(localBin, '', 'utf8')

    try {
      // Act
      const result = await resolveMammouthBin(home, 'linux')

      // Assert
      expect(result).toBe(localBin)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('falls back to the PATH command when the user-local binary is absent', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'delegate-mammouth-missing-'))

    try {
      // Act
      const result = await resolveMammouthBin(home, 'linux')

      // Assert
      expect(result).toBe('mammouth')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('uses the mammouth.exe name on win32', async () => {
    // Arrange
    const home = await mkdtemp(join(tmpdir(), 'delegate-mammouth-win32-'))
    const localBin = join(home, '.mammouth', 'bin', 'mammouth.exe')
    await mkdir(join(home, '.mammouth', 'bin'), { recursive: true })
    await writeFile(localBin, '', 'utf8')

    try {
      // Act
      const result = await resolveMammouthBin(home, 'win32')

      // Assert
      expect(result).toBe(localBin)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('runMammouth', () => {
  let temporaryRoot: string
  let mammouthBin: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'delegate-mammouth-runner-'))
    mammouthBin = join(temporaryRoot, 'fake-mammouth')
    await writeFile(
      mammouthBin,
      `#!/usr/bin/env node
const prompt = process.argv.at(-1)
if (prompt === 'success') {
  process.stdout.write('{"type":"step_start"}\\n')
  process.stdout.write('{"type":"text","part":{"text":"first"}}\\n')
  process.stdout.write('{"type":"text","part":{"text":"pong"}}\\n')
} else if (prompt === 'error') {
  process.stdout.write('{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error."}}}\\n')
  process.exitCode = 1
} else if (prompt === 'quota') {
  process.stdout.write('{"type":"error","error":{"name":"QuotaError","data":{"message":"Rate limit reached; retry-after: 60"}}}\\n')
  process.exitCode = 1
}
`,
      'utf8',
    )
    await chmod(mammouthBin, 0o755)
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  async function runFakeMammouth(prompt: string) {
    const paths = buildJobPaths(temporaryRoot, `job-${prompt}`)
    await mkdir(paths.jobDir, { recursive: true })
    return runMammouth({
      mammouthBin,
      worktreePath: temporaryRoot,
      prompt,
      paths,
    })
  }

  test('returns the last text event from a successful NDJSON run', async () => {
    // Act
    const outcome = await runFakeMammouth('success')

    // Assert
    expect(outcome.exitCode).toBe(0)
    expect(outcome.lastMessage).toBe('pong')
    expect(outcome.failureKind).toBeUndefined()
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('surfaces an error event message when the CLI exits with failure', async () => {
    // Act
    const outcome = await runFakeMammouth('error')

    // Assert
    expect(outcome.exitCode).toBe(1)
    expect(outcome.lastMessage).toBe('Unexpected server error.')
    expect(outcome.failureKind).toBe('other')
  })

  test('classifies quota output and exposes its retry time', async () => {
    // Arrange
    const beforeRun = Date.now()

    // Act
    const outcome = await runFakeMammouth('quota')

    // Assert
    expect(outcome.exitCode).toBe(1)
    expect(outcome.failureKind).toBe('quota')
    expect(outcome.retryAtMs).toBeGreaterThanOrEqual(beforeRun + 60_000)
    expect(outcome.retryAtMs).toBeLessThanOrEqual(Date.now() + 60_000)
  })
})
