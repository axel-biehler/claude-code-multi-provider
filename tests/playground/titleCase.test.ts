import { describe, expect, test } from 'vitest'
import { titleCase } from '../../src/playground/titleCase'

describe('titleCase', () => {
  test('capitalizes each word in a simple two-word phrase', () => {
    // Arrange
    const input = 'hello world'

    // Act
    const result = titleCase(input)

    // Assert
    expect(result).toBe('Hello World')
  })

  test('normalizes already-uppercase input', () => {
    // Arrange
    const input = 'HELLO WORLD'

    // Act
    const result = titleCase(input)

    // Assert
    expect(result).toBe('Hello World')
  })

  test('capitalizes a single word', () => {
    // Arrange
    const input = 'hELLO'

    // Act
    const result = titleCase(input)

    // Assert
    expect(result).toBe('Hello')
  })

  test('returns an empty string for empty input', () => {
    // Arrange
    const input = ''

    // Act
    const result = titleCase(input)

    // Assert
    expect(result).toBe('')
  })
})
