import { describe, expect, test } from 'vitest'
import { WORKER_ALLOWED_TOOLS, classifyClaudeFailure, parseClaudeJson } from '../../src/engines/claude'

describe('WORKER_ALLOWED_TOOLS', () => {
  test('every rule uses the colon-prefix Bash grammar (finding 6 regression)', () => {
    // Arrange
    const rules = WORKER_ALLOWED_TOOLS.split(',')

    // Act + Assert — the space form silently left Bash gated in Phase 0
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule).toMatch(/^Bash\([^)]+:\*\)$/)
    }
  })
})

describe('parseClaudeJson', () => {
  test('extracts the result field from a valid claude json payload', () => {
    // Arrange
    const raw = JSON.stringify({ result: 'Implemented slugify.', session_id: 'abc', total_cost_usd: 0.01 })

    // Act
    const { lastMessage } = parseClaudeJson(raw)

    // Assert
    expect(lastMessage).toBe('Implemented slugify.')
  })

  test('returns null when result is missing or not a string', () => {
    // Arrange
    const missing = JSON.stringify({ session_id: 'abc' })
    const wrongType = JSON.stringify({ result: 42 })

    // Act + Assert
    expect(parseClaudeJson(missing).lastMessage).toBeNull()
    expect(parseClaudeJson(wrongType).lastMessage).toBeNull()
  })

  test('returns null on malformed json or empty input', () => {
    expect(parseClaudeJson('not json at all').lastMessage).toBeNull()
    expect(parseClaudeJson('').lastMessage).toBeNull()
  })
})

describe('classifyClaudeFailure', () => {
  test('returns undefined on exit 0 even when stderr looks alarming', () => {
    // Arrange
    const input = {
      exitCode: 0,
      resultJson: JSON.stringify({ result: 'Done.' }),
      stderrText: 'warn: transient 401 unauthorized retried; usage limit approaching',
    }

    // Act
    const kind = classifyClaudeFailure(input)

    // Assert
    expect(kind).toBeUndefined()
  })

  test('classifies a usage-limit message as quota', () => {
    // Arrange
    const input = {
      exitCode: 1,
      resultJson: JSON.stringify({ error: "You've hit your usage limit." }),
      stderrText: '',
    }

    // Act
    const kind = classifyClaudeFailure(input)

    // Assert
    expect(kind).toBe('quota')
  })

  test('classifies the observed 401 invalid credentials as auth', () => {
    // Arrange
    const input = {
      exitCode: 1,
      resultJson: '',
      stderrText: 'API Error: 401 invalid credentials',
    }

    // Act
    const kind = classifyClaudeFailure(input)

    // Assert
    expect(kind).toBe('auth')
  })

  test('classifies the observed revoked token as auth', () => {
    // Arrange
    const input = {
      exitCode: 1,
      resultJson: JSON.stringify({ error: 'OAuth token revoked. Please run /login' }),
      stderrText: '',
    }

    // Act
    const kind = classifyClaudeFailure(input)

    // Assert
    expect(kind).toBe('auth')
  })

  test('classifies an unrecognized non-zero exit as other', () => {
    // Arrange
    const input = {
      exitCode: 1,
      resultJson: '',
      stderrText: 'segmentation fault',
    }

    // Act
    const kind = classifyClaudeFailure(input)

    // Assert
    expect(kind).toBe('other')
  })

  test('classifies a max-budget stop as other, not quota', () => {
    // Arrange
    const budgetStop = {
      exitCode: 1,
      resultJson: JSON.stringify({ result: 'Reached max budget of $2' }),
      stderrText: '',
    }
    const budgetWithQuotaWording = {
      exitCode: 1,
      resultJson: JSON.stringify({ result: 'Budget limit exceeded: usage limit for this job' }),
      stderrText: '',
    }

    // Act + Assert
    expect(classifyClaudeFailure(budgetStop)).toBe('other')
    expect(classifyClaudeFailure(budgetWithQuotaWording)).toBe('other')
  })

  test('prefers quota over auth when both patterns match', () => {
    // Arrange
    const input = {
      exitCode: 1,
      resultJson: JSON.stringify({ error: '429 Too Many Requests' }),
      stderrText: 'authentication succeeded but rate limit reached',
    }

    // Act
    const kind = classifyClaudeFailure(input)

    // Assert
    expect(kind).toBe('quota')
  })
})
