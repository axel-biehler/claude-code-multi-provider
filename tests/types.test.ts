import { describe, expect, test } from 'vitest'
import { DelegateTaskSchema, DelegateTaskShape } from '../src/types'

describe('DelegateTaskSchema', () => {
  test.each(['light', 'standard', 'heavy'] as const)('accepts %s effort', (effort) => {
    // Arrange
    const input = { objective: 'Implement the task', effort }

    // Act
    const result = DelegateTaskSchema.safeParse(input)

    // Assert
    expect(result).toEqual({ success: true, data: input })
  })

  test('rejects an invalid effort', () => {
    // Arrange
    const input = { objective: 'Implement the task', effort: 'extreme' }

    // Act
    const result = DelegateTaskSchema.safeParse(input)

    // Assert
    expect(result.success).toBe(false)
  })

  test('allows effort to be omitted', () => {
    // Arrange
    const input = { objective: 'Implement the task' }

    // Act
    const result = DelegateTaskSchema.safeParse(input)

    // Assert
    expect(result).toEqual({ success: true, data: input })
  })

  test('directs the orchestrator to always assess effort and explains revision escalation', () => {
    // Act
    const description = DelegateTaskShape.effort.description

    // Assert
    expect(description).toContain('always assess and set it')
    expect(description).toContain('Selects the worker model and reasoning tier')
    expect(description).toContain('revision without an explicit effort')
    expect(description).not.toMatch(/codex|claude|antigravity/i)
  })

  test('rejects feedback without a parent job id', () => {
    // Arrange
    const input = { objective: 'Revise the implementation', feedback: 'Handle empty input' }

    // Act
    const result = DelegateTaskSchema.safeParse(input)

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['feedback'], message: 'feedback requires parent_job_id' }),
        ]),
      )
    }
  })

  test('rejects escalation without a parent job id', () => {
    // Arrange
    const input = { objective: 'Escalate the implementation', escalate: true }

    // Act
    const result = DelegateTaskSchema.safeParse(input)

    // Assert
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['escalate'], message: 'escalate requires parent_job_id' }),
        ]),
      )
    }
  })

  test('accepts a parent job id with feedback and escalation', () => {
    // Arrange
    const input = {
      objective: 'Revise the implementation',
      parent_job_id: 'parent-123',
      feedback: 'Handle empty input',
      escalate: true,
    }

    // Act
    const result = DelegateTaskSchema.safeParse(input)

    // Assert
    expect(result).toEqual({ success: true, data: input })
  })
})
