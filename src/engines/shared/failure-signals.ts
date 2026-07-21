import type { FailureKind } from '../../types'

const QUOTA_PATTERN = /usage limit|rate limit|quota|too many requests|\b429\b/i
const AUTH_PATTERN =
  /\b401\b|unauthorized|invalid credentials|not logged in|token revoked|authentication/i

// Quota wins when both match: exhaustion responses often carry auth-flavored wording,
// and cooldown-this-engine is the actionable routing signal (re-login wouldn't help).
export function classifyFailureText(text: string): FailureKind {
  if (QUOTA_PATTERN.test(text)) return 'quota'
  if (AUTH_PATTERN.test(text)) return 'auth'
  return 'other'
}

interface RetryCandidate {
  readonly index: number
  readonly atMs: number
}

const RELATIVE_DURATION_PATTERN =
  /\b(?:try\s+again\s+)?in\s+((?:\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/gi
const DURATION_PART_PATTERN =
  /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi

function durationToMs(text: string): number | undefined {
  let durationMs = 0
  let foundPart = false
  for (const match of text.matchAll(DURATION_PART_PATTERN)) {
    const amount = Number(match[1])
    const unit = match[2]?.toLowerCase()
    if (!Number.isFinite(amount) || unit === undefined) continue
    foundPart = true
    if (unit.startsWith('h')) durationMs += amount * 60 * 60_000
    else if (unit.startsWith('m')) durationMs += amount * 60_000
    else durationMs += amount * 1_000
  }
  return foundPart && Number.isFinite(durationMs) ? durationMs : undefined
}

// Vendor CLIs surface reset metadata in several human-readable and JSON-ish forms.
// Collecting candidates with their source positions preserves the first-signal contract
// across pattern families rather than giving any one vendor format artificial priority.
export function parseRetryAt(text: string, nowMs: number): number | undefined {
  try {
    if (typeof text !== 'string' || !Number.isFinite(nowMs)) return undefined
    const candidates: RetryCandidate[] = []
    // matchAll guarantees .index at runtime but the lib typings keep it optional.
    const addCandidate = (index: number | undefined, atMs: number): void => {
      if (index !== undefined && Number.isFinite(atMs) && Number.isFinite(new Date(atMs).getTime())) {
        candidates.push({ index, atMs })
      }
    }

    for (const match of text.matchAll(/\bretry-after\s*:\s*(\d+)\b/gi)) {
      addCandidate(match.index, nowMs + Number(match[1]) * 1_000)
    }
    for (const match of text.matchAll(/\bretry\s+after\s+(\d+)\s+seconds?\b/gi)) {
      addCandidate(match.index, nowMs + Number(match[1]) * 1_000)
    }
    for (const match of text.matchAll(RELATIVE_DURATION_PATTERN)) {
      const durationMs = durationToMs(match[1] ?? '')
      if (durationMs !== undefined) addCandidate(match.index, nowMs + durationMs)
    }
    for (const match of text.matchAll(/\bresets(?:\s+at|_at)["']?\s*(?::|=)?\s*["']?([^\s"',}]+)/gi)) {
      const value = match[1]
      if (value !== undefined && /^\d{4}-/.test(value)) {
        addCandidate(match.index, Date.parse(value.replace(/[;.)]+$/, '')))
      }
    }
    for (const match of text.matchAll(/["']?resets_at["']?\s*:\s*(\d+)\b/gi)) {
      const value = Number(match[1])
      addCandidate(match.index, value > 1e12 ? value : value * 1_000)
    }

    const first = candidates.sort((left, right) => left.index - right.index)[0]
    return first !== undefined && first.atMs > nowMs ? first.atMs : undefined
  } catch {
    return undefined
  }
}
