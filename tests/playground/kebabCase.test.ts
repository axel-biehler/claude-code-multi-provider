import { describe, expect, test } from 'vitest'
import { kebabCase } from '../../src/playground/kebabCase'

describe('kebabCase', () => {
  test('joins a simple two-word phrase with a hyphen', () => {
    // Arrange
    const input = 'hello world'

    // Act
    const result = kebabCase(input)

    // Assert
    expect(result).toBe('hello-world')
  })

  test('normalizes already-uppercase input', () => {
    // Arrange
    const input = 'HELLO WORLD'

    // Act
    const result = kebabCase(input)

    // Assert
    expect(result).toBe('hello-world')
  })

  test('lowercases a single word', () => {
    // Arrange
    const input = 'HELLO'

    // Act
    const result = kebabCase(input)

    // Assert
    expect(result).toBe('hello')
  })

  test('returns an empty string for empty input', () => {
    // Arrange
    const input = ''

    // Act
    const result = kebabCase(input)

    // Assert
    expect(result).toBe('')
  })
})
