import { describe, expect, test } from 'vitest'
import { buildPrompt } from '../../../src/engines/shared/prompt'
import type { DelegateTask } from '../../../src/types'

describe('buildPrompt', () => {
  test('includes the objective heading and text', () => {
    // Arrange
    const task: DelegateTask = { objective: 'Add a health check endpoint' }

    // Act
    const prompt = buildPrompt(task)

    // Assert
    expect(prompt).toContain('# Objective')
    expect(prompt).toContain(task.objective)
  })

  test('lists each file path under Files in scope when files are provided', () => {
    // Arrange
    const task: DelegateTask = {
      objective: 'Refactor the parser',
      files: ['src/parser.ts', 'src/lexer.ts'],
    }

    // Act
    const prompt = buildPrompt(task)

    // Assert
    expect(prompt).toContain('## Files in scope')
    expect(prompt).toContain('- src/parser.ts')
    expect(prompt).toContain('- src/lexer.ts')
  })

  test('omits the Files in scope section when no files are given', () => {
    // Arrange
    const task: DelegateTask = { objective: 'Write a README section' }

    // Act
    const prompt = buildPrompt(task)

    // Assert
    expect(prompt).not.toContain('## Files in scope')
  })

  test('includes the Context section only when context is provided', () => {
    // Arrange
    const withContext: DelegateTask = {
      objective: 'Fix the flaky test',
      context: 'The test suite uses vitest with fake timers',
    }
    const withoutContext: DelegateTask = { objective: 'Fix the flaky test' }

    // Act
    const promptWithContext = buildPrompt(withContext)
    const promptWithoutContext = buildPrompt(withoutContext)

    // Assert
    expect(promptWithContext).toContain('## Context')
    expect(promptWithContext).toContain('The test suite uses vitest with fake timers')
    expect(promptWithoutContext).not.toContain('## Context')
  })

  test('numbers each acceptance criterion under Acceptance criteria', () => {
    // Arrange
    const task: DelegateTask = {
      objective: 'Add input validation',
      acceptance: ['Rejects empty strings', 'Rejects negative numbers'],
    }

    // Act
    const prompt = buildPrompt(task)

    // Assert
    expect(prompt).toContain('## Acceptance criteria')
    expect(prompt).toContain('1. Rejects empty strings')
    expect(prompt).toContain('2. Rejects negative numbers')
  })

  test('always includes the rule forbidding commits regardless of optional fields', () => {
    // Arrange
    const task: DelegateTask = { objective: 'Minimal task with no optional fields' }

    // Act
    const prompt = buildPrompt(task)

    // Assert
    expect(prompt).toContain('## Rules')
    expect(prompt.toLowerCase()).toContain('do not commit')
  })

  test('adds previous-attempt and reviewer-feedback sections before Rules for a revision', () => {
    // Arrange
    const task: DelegateTask = { objective: 'Revise the parser' }

    // Act
    const prompt = buildPrompt(task, { feedback: 'Preserve comments while parsing' })

    // Assert
    expect(prompt).toContain('## Previous attempt')
    expect(prompt).toContain('The working tree already contains the previous attempt')
    expect(prompt).toContain('## Reviewer feedback\nPreserve comments while parsing')
    expect(prompt.indexOf('## Previous attempt')).toBeLessThan(prompt.indexOf('## Rules'))
    expect(prompt.indexOf('## Reviewer feedback')).toBeLessThan(prompt.indexOf('## Rules'))
  })

  test('adds the previous-attempt section without feedback when none was supplied', () => {
    // Arrange
    const task: DelegateTask = { objective: 'Revise the parser' }

    // Act
    const prompt = buildPrompt(task, {})

    // Assert
    expect(prompt).toContain('## Previous attempt')
    expect(prompt).not.toContain('## Reviewer feedback')
  })

  test('omits all revision sections for a fresh task', () => {
    // Arrange
    const task: DelegateTask = { objective: 'Build the parser' }

    // Act
    const prompt = buildPrompt(task)

    // Assert
    expect(prompt).not.toContain('## Previous attempt')
    expect(prompt).not.toContain('## Reviewer feedback')
  })
})
