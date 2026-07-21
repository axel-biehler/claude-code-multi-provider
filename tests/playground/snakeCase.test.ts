import { describe, expect, test } from 'vitest'
import { snakeCase } from '../../src/playground/snakeCase'

describe('snakeCase', () => {
  test('joins a simple two-word phrase with an underscore', () => {
    // Arrange
    const input = 'hello world'

    // Act
    const result = snakeCase(input)

    // Assert
    expect(result).toBe('hello_world')
  })

  test('normalizes already-uppercase input', () => {
    // Arrange
    const input = 'HELLO WORLD'

    // Act
    const result = snakeCase(input)

    // Assert
    expect(result).toBe('hello_world')
  })

  test('lowercases a single word', () => {
    // Arrange
    const input = 'HELLO'

    // Act
    const result = snakeCase(input)

    // Assert
    expect(result).toBe('hello')
  })

  test('returns an empty string for empty input', () => {
    // Arrange
    const input = ''

    // Act
    const result = snakeCase(input)

    // Assert
    expect(result).toBe('')
  })
})
