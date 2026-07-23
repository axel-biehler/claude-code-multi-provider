import { describe, expect, test } from 'vitest'
import {
  buildAntigravityArgs,
  classifyAntigravityFailure,
  parseAntigravityJson,
} from '../../src/engines/antigravity'

const baseOptions = {
  agyBin: 'agy',
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

describe('parseAntigravityJson', () => {
  test('extracts the trimmed response and status from a valid agy payload', () => {
    // Arrange
    const raw =
      '{"conversation_id":"37ec10bc-...","status":"SUCCESS","response":"ok\\n","duration_seconds":1.38,"num_turns":1,"usage":{"input_tokens":8611,"output_tokens":39,"thinking_tokens":35,"total_tokens":8650}}'

    // Act
    const result = parseAntigravityJson(raw)

    // Assert
    expect(result).toEqual({ lastMessage: 'ok', status: 'SUCCESS' })
  })

  test('returns null fields for malformed json', () => {
    expect(parseAntigravityJson('not json at all')).toEqual({ lastMessage: null, status: null })
  })

  test('returns null lastMessage when response is missing or not a string', () => {
    // Arrange
    const missing = JSON.stringify({ status: 'SUCCESS' })
    const wrongType = JSON.stringify({ status: 'SUCCESS', response: 42 })

    // Act + Assert
    expect(parseAntigravityJson(missing)).toEqual({ lastMessage: null, status: 'SUCCESS' })
    expect(parseAntigravityJson(wrongType)).toEqual({ lastMessage: null, status: 'SUCCESS' })
  })
})

describe('classifyAntigravityFailure', () => {
  test('returns undefined on exit 0', () => {
    expect(
      classifyAntigravityFailure({
        exitCode: 0,
        resultJson: JSON.stringify({ status: 'SUCCESS' }),
        stderrText: 'not logged in and rate limit reached',
      }),
    ).toBeUndefined()
  })

  test('classifies a not-logged-in message as auth', () => {
    expect(
      classifyAntigravityFailure({ exitCode: 1, resultJson: '', stderrText: 'Not logged in' }),
    ).toBe('auth')
  })

  test('classifies a rate-limit message as quota', () => {
    expect(
      classifyAntigravityFailure({
        exitCode: 1,
        resultJson: JSON.stringify({ error: 'Rate limit reached' }),
        stderrText: '',
      }),
    ).toBe('quota')
  })

  test('classifies an unrecognized failure as other', () => {
    expect(
      classifyAntigravityFailure({ exitCode: 1, resultJson: '', stderrText: 'plain error' }),
    ).toBe('other')
  })
})

describe('buildAntigravityArgs', () => {
  test('builds the ordered flags with a timeout derived in seconds', () => {
    // Arrange
    const options = { ...baseOptions, timeoutMs: 120_000 }

    // Act
    const args = buildAntigravityArgs(options)

    // Assert
    expect(args).toEqual([
      '-p',
      'Implement the requested change',
      '--add-dir',
      '/tmp/worktree',
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--print-timeout',
      '120s',
    ])
  })

  test('pins the worktree as the agy workspace via --add-dir', () => {
    const args = buildAntigravityArgs({ ...baseOptions, worktreePath: '/tmp/sandbox-xyz' })

    const idx = args.indexOf('--add-dir')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('/tmp/sandbox-xyz')
  })

  test('includes the model in single-token form when configured', () => {
    const args = buildAntigravityArgs({ ...baseOptions, model: 'gemini-2.5-pro' })

    expect(args.at(-1)).toBe('--model=gemini-2.5-pro')
  })

  test('omits the model flag when no model is configured', () => {
    const args = buildAntigravityArgs(baseOptions)

    expect(args.some((arg) => arg.startsWith('--model'))).toBe(false)
  })

  test('includes reasoning in equals form when configured', () => {
    const args = buildAntigravityArgs({ ...baseOptions, reasoning: 'high' })

    expect(args).toContain('--effort=high')
  })

  test('omits the effort flag when reasoning is undefined', () => {
    const args = buildAntigravityArgs(baseOptions)

    expect(args.some((arg) => arg.startsWith('--effort='))).toBe(false)
  })
})
