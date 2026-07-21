import { describe, expect, test } from 'vitest'
import { parseRetryAt } from '../../../src/engines/shared/failure-signals'

describe('parseRetryAt', () => {
  const nowMs = 1_700_000_000_000

  test.each([
    ['Retry-After header', 'Retry-After: 3600', 3_600_000],
    ['retry-after prose', 'retry after 3600 seconds', 3_600_000],
  ])('parses %s as integer seconds', (_label, text, offsetMs) => {
    // Arrange + Act
    const retryAtMs = parseRetryAt(text, nowMs)

    // Assert
    expect(retryAtMs).toBe(nowMs + offsetMs)
  })

  test.each([
    ['try again in 1 hour 13 minutes', 4_380_000],
    ['in 45 minutes', 2_700_000],
    ['in 90 seconds', 90_000],
    ['in 2h', 7_200_000],
    ['in 1h13m', 4_380_000],
    ['in 75s', 75_000],
    ['in 30m', 1_800_000],
  ])('parses the relative duration in %s', (text, offsetMs) => {
    // Arrange + Act
    const retryAtMs = parseRetryAt(text, nowMs)

    // Assert
    expect(retryAtMs).toBe(nowMs + offsetMs)
  })

  test.each([
    ['resets at', 'Usage limit reached; resets at 2026-07-18T14:00:00Z'],
    ['resets_at', 'Usage limit reached; "resets_at": "2026-07-18T14:00:00Z"'],
  ])('parses an ISO 8601 timestamp after %s', (_label, text) => {
    // Arrange
    const beforeResetMs = Date.parse('2026-07-18T13:00:00Z')

    // Act
    const retryAtMs = parseRetryAt(text, beforeResetMs)

    // Assert
    expect(retryAtMs).toBe(Date.parse('2026-07-18T14:00:00Z'))
  })

  test.each([
    ['seconds', '"resets_at": 1752849600', 1_752_849_600_000],
    ['milliseconds', '"resets_at": 1752849600000', 1_752_849_600_000],
  ])('parses JSON-ish epoch fields expressed in %s', (_unit, text, expectedMs) => {
    // Arrange + Act
    const retryAtMs = parseRetryAt(text, nowMs)

    // Assert
    expect(retryAtMs).toBe(expectedMs)
  })

  test('uses the first recognizable signal in the text', () => {
    // Arrange
    const text = 'try again in 30m; secondary hint: Retry-After: 7200'

    // Act
    const retryAtMs = parseRetryAt(text, nowMs)

    // Assert
    expect(retryAtMs).toBe(nowMs + 30 * 60_000)
  })

  test('returns undefined without throwing on garbage input', () => {
    // Arrange
    const text = '{ resets_at: definitely-not-a-date, retry whenever }'

    // Act + Assert
    expect(() => parseRetryAt(text, nowMs)).not.toThrow()
    expect(parseRetryAt(text, nowMs)).toBeUndefined()
  })

  test('rejects a parsed timestamp that is not strictly in the future', () => {
    // Arrange
    const text = 'resets at 2026-07-18T14:00:00Z'
    const resetMs = Date.parse('2026-07-18T14:00:00Z')

    // Act
    const retryAtMs = parseRetryAt(text, resetMs)

    // Assert
    expect(retryAtMs).toBeUndefined()
  })
})
