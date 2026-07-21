import type { DelegateTask } from '../../types'

const RULES_TEXT =
  'work only inside this repository checkout; do NOT commit — leave all changes uncommitted in the working tree; add or update tests covering your change when a test setup exists; keep changes minimal and focused on the objective.'

const PREVIOUS_ATTEMPT_TEXT =
  'The working tree already contains the previous attempt as uncommitted changes. Revise that work according to the feedback — do not start from scratch and do not blindly rewrite unrelated parts.'

export interface PromptRevision {
  readonly feedback?: string
}

export function buildPrompt(task: DelegateTask, revision?: PromptRevision): string {
  const sections = [
    `# Objective\n${task.objective}`,
    buildFilesSection(task.files),
    buildContextSection(task.context),
    buildAcceptanceSection(task.acceptance),
    revision === undefined ? null : `## Previous attempt\n${PREVIOUS_ATTEMPT_TEXT}`,
    revision?.feedback === undefined ? null : `## Reviewer feedback\n${revision.feedback}`,
    `## Rules\n${RULES_TEXT}`,
  ]

  return sections.filter(isNonNull).join('\n\n')
}

function isNonNull(section: string | null): section is string {
  return section !== null
}

function buildFilesSection(files: string[] | undefined): string | null {
  if (!files || files.length === 0) return null
  const bullets = files.map((file) => `- ${file}`).join('\n')
  return `## Files in scope\n${bullets}`
}

function buildContextSection(context: string | undefined): string | null {
  if (!context) return null
  return `## Context\n${context}`
}

function buildAcceptanceSection(acceptance: string[] | undefined): string | null {
  if (!acceptance || acceptance.length === 0) return null
  const items = acceptance.map((item, index) => `${index + 1}. ${item}`).join('\n')
  return `## Acceptance criteria\n${items}`
}
