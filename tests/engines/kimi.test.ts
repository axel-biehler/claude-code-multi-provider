import { describe, expect, test } from 'vitest'
import {
  buildKimiArgs,
  classifyKimiFailure,
  parseKimiStreamJson,
} from '../../src/engines/kimi'

const baseOptions = {
  kimiBin: 'kimi',
  worktreePath: '/tmp/worktree',
  prompt: 'Implement the requested change',
  paths: {
    jobDir: '/tmp/job',
    promptFile: '/tmp/job/prompt.md',
    eventsFile: '/tmp/job/events.jsonl',
    stderrFile: '/tmp/job/stderr.log',
    lastMessageFile: '/tmp/job/last-message.md',
    diffFile: '/tmp/job/diff.patch',
    statusFile: '/tmp/job/status.json',
  },
}

describe('parseKimiStreamJson', () => {
  test('extracts the assistant content from a single stream line', () => {
    // Arrange
    const raw = '{"role":"assistant","content":"Hello!"}'

    // Act
    const result = parseKimiStreamJson(raw)

    // Assert
    expect(result).toEqual({ lastMessage: 'Hello!' })
  })

  test('returns the final assistant message after tool activity', () => {
    // Arrange
    const raw = [
      '{"role":"assistant","content":"Let me check.","tool_calls":[{"type":"function","id":"tc_1","function":{"name":"Shell","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
      '{"role":"tool","tool_call_id":"tc_1","content":"file1.py"}',
      '{"role":"assistant","content":"The final answer."}',
    ].join('\n')

    // Act
    const result = parseKimiStreamJson(raw)

    // Assert
    expect(result).toEqual({ lastMessage: 'The final answer.' })
  })

  test('joins text parts from array-form assistant content', () => {
    // Arrange
    const raw = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello, ' },
        { type: 'image', image_url: 'ignored' },
        { type: 'text', text: 'world!' },
      ],
    })

    // Act
    const result = parseKimiStreamJson(raw)

    // Assert
    expect(result).toEqual({ lastMessage: 'Hello, world!' })
  })

  test('silently skips malformed and non-object lines', () => {
    // Arrange
    const raw = [
      'not json',
      '"a string"',
      '{"role":"assistant","content":"First"}',
      '{"role":',
      'null',
      '{"role":"assistant","content":"Last"}',
    ].join('\n')

    // Act
    const result = parseKimiStreamJson(raw)

    // Assert
    expect(result).toEqual({ lastMessage: 'Last' })
  })

  test('returns null for an empty stream', () => {
    expect(parseKimiStreamJson('')).toEqual({ lastMessage: null })
  })

  test('returns null for a tool-only stream', () => {
    const raw = '{"role":"tool","tool_call_id":"tc_1","content":"file1.py"}'

    expect(parseKimiStreamJson(raw)).toEqual({ lastMessage: null })
  })
})

describe('classifyKimiFailure', () => {
  test('returns undefined on exit 0', () => {
    expect(
      classifyKimiFailure({
        exitCode: 0,
        streamText: '{"role":"assistant","content":"ok"}',
        stderrText: 'No model configured. Run `kimi` and use /login to sign in.',
      }),
    ).toBeUndefined()
  })

  test('classifies the live logged-out CLI error as auth', () => {
    expect(
      classifyKimiFailure({
        exitCode: 1,
        streamText: '',
        stderrText:
          'error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
      }),
    ).toBe('auth')
  })

  test('classifies a too-many-requests response as quota', () => {
    expect(
      classifyKimiFailure({
        exitCode: 1,
        streamText: '{"error":"429 Too Many Requests"}',
        stderrText: '',
      }),
    ).toBe('quota')
  })

  test('maps exit 75 with a plain 5xx response to quota', () => {
    expect(
      classifyKimiFailure({
        exitCode: 75,
        streamText: '',
        stderrText: 'upstream service returned 503',
      }),
    ).toBe('quota')
  })

  test('classifies an unrecognized exit 1 failure as other', () => {
    expect(
      classifyKimiFailure({
        exitCode: 1,
        streamText: '',
        stderrText: 'plain error',
      }),
    ).toBe('other')
  })
})

describe('buildKimiArgs', () => {
  test('builds the exact ordered flags without a model', () => {
    // Arrange
    const options = { ...baseOptions, timeoutMs: 120_000 }

    // Act
    const args = buildKimiArgs(options)

    // Assert
    expect(args).toEqual([
      '-p',
      'Implement the requested change',
      '--add-dir',
      '/tmp/worktree',
      '--output-format',
      'stream-json',
    ])
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--auto')
    expect(args.some((arg) => arg.includes('timeout'))).toBe(false)
  })

  test('includes the model in single-token form when configured', () => {
    // Arrange
    const options = { ...baseOptions, model: 'kimi-for-coding' }

    // Act
    const args = buildKimiArgs(options)

    // Assert
    expect(args).toEqual([
      '-p',
      'Implement the requested change',
      '--add-dir',
      '/tmp/worktree',
      '--output-format',
      'stream-json',
      '--model=kimi-for-coding',
    ])
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--auto')
    expect(args.some((arg) => arg.includes('timeout'))).toBe(false)
  })
})
