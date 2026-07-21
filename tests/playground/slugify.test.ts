import { describe, expect, test } from 'vitest'
import { slugify } from '../../src/playground/slugify'

describe('slugify', () => {
  test('converts a basic sentence to a dash-separated slug', () => {
    // Arrange
    const input = 'Hello World'

    // Act
    const result = slugify(input)

    // Assert
    expect(result).toBe('hello-world')
  })

  test('lowercases mixed-case input and strips punctuation', () => {
    // Arrange
    const input = "Café's Menu: Best Deals!"

    // Act
    const result = slugify(input)

    // Assert
    expect(result).toBe('caf-s-menu-best-deals')
  })

  test('collapses multiple consecutive separators into a single dash', () => {
    // Arrange
    const input = '  Foo   ---  Bar__Baz  '

    // Act
    const result = slugify(input)

    // Assert
    expect(result).toBe('foo-bar-baz')
  })

  test('returns an empty string for empty input', () => {
    // Arrange
    const input = ''

    // Act
    const result = slugify(input)

    // Assert
    expect(result).toBe('')
  })
})
