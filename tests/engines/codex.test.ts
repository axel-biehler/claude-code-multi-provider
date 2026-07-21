import { describe, expect, test, vi } from 'vitest'
import {
  CODEX_CONFIG_OVERRIDES,
  buildCodexArgs,
  buildMcpDisableOverrides,
  classifyCodexFailure,
  parseEvents,
  resolveCodexConfigOverrides,
} from '../../src/engines/codex'

describe('buildCodexArgs', () => {
  const baseOptions = {
    codexBin: 'codex',
    worktreePath: '/tmp/worktree',
    prompt: 'Implement the requested change',
    paths: {
      jobDir: '/tmp/job',
      promptFile: '/tmp/job/prompt.md',
      eventsFile: '/tmp/job/events.ndjson',
      stderrFile: '/tmp/job/stderr.log',
      lastMessageFile: '/tmp/job/last-message.md',
      diffFile: '/tmp/job/diff.patch',
      statusFile: '/tmp/job/status.json',
    },
  }

  test('includes the configured model before the codex config overrides', () => {
    // Arrange
    const options = { ...baseOptions, model: 'gpt-5.6-sol' }

    // Act
    const args = buildCodexArgs(options)

    // Assert — single-token --model=<id> form so a '-'-prefixed id can't become a flag
    const modelFlagIndex = args.indexOf('--model=gpt-5.6-sol')
    expect(modelFlagIndex).toBeGreaterThanOrEqual(0)
    expect(modelFlagIndex).toBeLessThan(args.indexOf(CODEX_CONFIG_OVERRIDES[0] ?? ''))
  })

  test('omits the model flag entirely when no model is configured', () => {
    // Arrange
    const options = baseOptions

    // Act
    const args = buildCodexArgs(options)

    // Assert
    expect(args.some((arg) => arg.startsWith('--model'))).toBe(false)
  })
})

describe('CODEX_CONFIG_OVERRIDES', () => {
  test('carries the -c mcp_servers={} pair that keeps personal MCP servers out of jobs', () => {
    // Act
    const flagIndex = CODEX_CONFIG_OVERRIDES.indexOf('-c')

    // Assert — the value must immediately follow its -c flag to form one override pair
    expect(flagIndex).toBeGreaterThanOrEqual(0)
    expect(CODEX_CONFIG_OVERRIDES[flagIndex + 1]).toBe('mcp_servers={}')
  })
})

describe('parseEvents', () => {
  test('returns the last agent_message text when multiple completed events exist', () => {
    // Arrange
    const ndjson = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread_1' }),
      '{not valid json',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'first message' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'final message' },
      }),
    ].join('\n')

    // Act
    const result = parseEvents(ndjson)

    // Assert
    expect(result).toEqual({ lastMessage: 'final message' })
  })

  test('returns null lastMessage for an empty string', () => {
    // Arrange
    const ndjson = ''

    // Act
    const result = parseEvents(ndjson)

    // Assert
    expect(result).toEqual({ lastMessage: null })
  })

  test('returns null lastMessage when the ndjson has no agent_message events', () => {
    // Arrange
    const ndjson = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread_1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'npm test' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n')

    // Act
    const result = parseEvents(ndjson)

    // Assert
    expect(result).toEqual({ lastMessage: null })
  })
})

describe('classifyCodexFailure', () => {
  test('returns undefined on exit 0 even when stderr looks alarming', () => {
    // Arrange
    const input = {
      exitCode: 0,
      eventsNdjson: '',
      stderrText: 'warn: transient 401 unauthorized retried; usage limit approaching',
    }

    // Act
    const kind = classifyCodexFailure(input)

    // Assert
    expect(kind).toBeUndefined()
  })

  test('classifies a usage-limit message in stderr as quota', () => {
    // Arrange
    const input = {
      exitCode: 1,
      eventsNdjson: '',
      stderrText: "You've hit your usage limit. Try again later.",
    }

    // Act
    const kind = classifyCodexFailure(input)

    // Assert
    expect(kind).toBe('quota')
  })

  test('classifies a 429 in the events ndjson as quota', () => {
    // Arrange
    const input = {
      exitCode: 1,
      eventsNdjson: JSON.stringify({ type: 'error', message: '429 Too Many Requests' }),
      stderrText: '',
    }

    // Act
    const kind = classifyCodexFailure(input)

    // Assert
    expect(kind).toBe('quota')
  })

  test('classifies 401 invalid credentials as auth', () => {
    // Arrange
    const input = {
      exitCode: 1,
      eventsNdjson: '',
      stderrText: 'ERROR: 401 invalid credentials',
    }

    // Act
    const kind = classifyCodexFailure(input)

    // Assert
    expect(kind).toBe('auth')
  })

  test('classifies a revoked token message as auth', () => {
    // Arrange
    const input = {
      exitCode: 1,
      eventsNdjson: JSON.stringify({ type: 'error', message: 'OAuth token revoked' }),
      stderrText: '',
    }

    // Act
    const kind = classifyCodexFailure(input)

    // Assert
    expect(kind).toBe('auth')
  })

  test('classifies an unrecognized non-zero exit as other', () => {
    // Arrange
    const input = {
      exitCode: 137,
      eventsNdjson: JSON.stringify({ type: 'turn.failed' }),
      stderrText: 'Killed',
    }

    // Act
    const kind = classifyCodexFailure(input)

    // Assert
    expect(kind).toBe('other')
  })

  test('prefers quota over auth when both patterns match', () => {
    // Arrange
    const input = {
      exitCode: 1,
      eventsNdjson: '',
      stderrText: 'authentication ok but quota exceeded for this billing period',
    }

    // Act
    const kind = classifyCodexFailure(input)

    // Assert
    expect(kind).toBe('quota')
  })
})

describe('buildMcpDisableOverrides', () => {
  test('emits one -c enabled=false pair per enabled server and skips disabled ones', () => {
    // Arrange
    const listJson = JSON.stringify([
      { name: 'MCP_DOCKER', enabled: true },
      { name: 'computer-use', enabled: false },
      { name: 'example-server', enabled: true },
    ])

    // Act
    const overrides = buildMcpDisableOverrides(listJson)

    // Assert
    expect(overrides).toEqual([
      '-c',
      'mcp_servers.MCP_DOCKER.enabled=false',
      '-c',
      'mcp_servers.example-server.enabled=false',
    ])
  })

  test('quotes server names that are not TOML bare keys', () => {
    // Arrange
    const listJson = JSON.stringify([{ name: 'my server.v2', enabled: true }])

    // Act
    const overrides = buildMcpDisableOverrides(listJson)

    // Assert
    expect(overrides).toEqual(['-c', 'mcp_servers."my server.v2".enabled=false'])
  })

  test.each([
    ['garbage text', 'not json at all'],
    ['non-array JSON', '{"name":"x","enabled":true}'],
    ['entries without a name', '[{"enabled":true},{"name":42,"enabled":true}]'],
  ])('returns no overrides for %s', (_label, listJson) => {
    // Arrange + Act
    const overrides = buildMcpDisableOverrides(listJson)

    // Assert
    expect(overrides).toEqual([])
  })
})

describe('resolveCodexConfigOverrides', () => {
  test('appends per-server disables to the blanket override when the listing works', async () => {
    // Arrange
    const runList = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ name: 'example-server', enabled: true }]))

    // Act
    const overrides = await resolveCodexConfigOverrides('/bin/codex', runList)

    // Assert
    expect(runList).toHaveBeenCalledWith('/bin/codex')
    expect(overrides).toEqual([
      ...CODEX_CONFIG_OVERRIDES,
      '-c',
      'mcp_servers.example-server.enabled=false',
    ])
  })

  test('falls back to the blanket override alone when the listing fails', async () => {
    // Arrange
    const runList = vi.fn().mockRejectedValue(new Error('unsupported subcommand'))

    // Act
    const overrides = await resolveCodexConfigOverrides('/bin/codex', runList)

    // Assert
    expect(overrides).toEqual(CODEX_CONFIG_OVERRIDES)
  })
})

