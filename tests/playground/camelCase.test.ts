import { describe, expect, test } from 'vitest'
import { camelCase } from '../../src/playground/camelCase'

describe('camelCase', () => {
  test('joins a simple two-word phrase in camel case', () => {
    // Arrange
    const input = 'hello world'

    // Act
    const result = camelCase(input)

    // Assert
    expect(result).toBe('helloWorld')
  })

  test('normalizes already-uppercase input', () => {
    // Arrange
    const input = 'HELLO WORLD'

    // Act
    const result = camelCase(input)

    // Assert
    expect(result).toBe('helloWorld')
  })

  test('lowercases a single word', () => {
    // Arrange
    const input = 'HELLO'

    // Act
    const result = camelCase(input)

    // Assert
    expect(result).toBe('hello')
  })

  test('returns an empty string for empty input', () => {
    // Arrange
    const input = ''

    // Act
    const result = camelCase(input)

    // Assert
    expect(result).toBe('')
  })
})
