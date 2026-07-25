import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { EngineName, FailureKind, QuotaConfig } from '../types'

export const WINDOW_5H_MS = 5 * 60 * 60 * 1000
export const WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface LedgerAttempt {
  readonly engine: EngineName
  readonly at: number
  readonly durationMs: number
  readonly outcome: 'ok' | FailureKind
}

export interface LedgerState {
  readonly attempts: readonly LedgerAttempt[]
  readonly exhaustedUntil: Readonly<Partial<Record<EngineName, number>>>
}

// Runtime mirror of EngineName/FailureKind — zod needs literals the type system can't supply.
const attemptSchema = z.object({
  engine: z.enum(['codex', 'claude', 'antigravity', 'kimi', 'mammouth']),
  at: z.number().finite(),
  durationMs: z.number().finite(),
  outcome: z.enum(['ok', 'quota', 'auth', 'other']),
})

const persistedLedgerSchema = z.object({
  attempts: z.array(attemptSchema),
  exhaustedUntil: z.object({
    codex: z.number().finite().optional(),
    claude: z.number().finite().optional(),
    antigravity: z.number().finite().optional(),
    kimi: z.number().finite().optional(),
    mammouth: z.number().finite().optional(),
  }),
})

const EMPTY_STATE: LedgerState = { attempts: [], exhaustedUntil: {} }

// 'quota'/'auth' attempts died at the door and consumed no engine tokens.
function consumesQuota(outcome: LedgerAttempt['outcome']): boolean {
  return outcome === 'ok' || outcome === 'other'
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Proxy for the vendors' 5h/weekly usage windows (we cannot read their real counters),
 * plus a circuit breaker for observed quota exhaustion. Persists to
 * `<repoRoot>/.delegate/quota-ledger.json` so wall-clock windows survive server restarts.
 */
export class QuotaLedger {
  private readonly filePath: string
  private readonly now: () => number
  private state: LedgerState
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(filePath: string, state: LedgerState, now: () => number) {
    this.filePath = filePath
    this.state = state
    this.now = now
  }

  static async load(repoRoot: string, now: () => number = Date.now): Promise<QuotaLedger> {
    const filePath = join(repoRoot, '.delegate', 'quota-ledger.json')
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = persistedLedgerSchema.parse(JSON.parse(raw))
      return new QuotaLedger(filePath, parsed, now)
    } catch (error) {
      // A bad ledger must never take the server down — worst case we forget past usage.
      if (!isEnoent(error)) {
        const detail = error instanceof Error ? error.message : String(error)
        console.error(`[delegate] quota ledger at ${filePath} is unreadable, starting fresh: ${detail}`)
      }
      return new QuotaLedger(filePath, EMPTY_STATE, now)
    }
  }

  hasHeadroom(engine: EngineName, quota: QuotaConfig): boolean {
    const at = this.now()

    const blockedUntil = this.state.exhaustedUntil[engine]
    if (blockedUntil !== undefined && blockedUntil > at) return false

    const consuming = this.state.attempts.filter(
      (attempt) => attempt.engine === engine && consumesQuota(attempt.outcome)
    )
    const within5h = consuming.filter((attempt) => at - attempt.at < WINDOW_5H_MS).length
    if (within5h >= quota.maxJobsPer5h) return false

    const withinWeek = consuming.filter((attempt) => at - attempt.at < WINDOW_WEEK_MS).length
    return withinWeek < quota.maxJobsPerWeek
  }

  async record(input: {
    readonly engine: EngineName
    readonly durationMs: number
    readonly outcome: 'ok' | FailureKind
  }): Promise<void> {
    const at = this.now()
    const weekFloor = at - WINDOW_WEEK_MS
    const attempt: LedgerAttempt = {
      engine: input.engine,
      at,
      durationMs: input.durationMs,
      outcome: input.outcome,
    }
    this.state = {
      ...this.state,
      attempts: [...this.state.attempts.filter((kept) => kept.at >= weekFloor), attempt],
    }
    await this.persist()
  }

  async markExhausted(engine: EngineName, cooldownMinutes: number): Promise<void> {
    await this.markExhaustedUntil(engine, this.now() + cooldownMinutes * 60_000)
  }

  async markExhaustedUntil(engine: EngineName, untilMs: number): Promise<void> {
    this.state = {
      ...this.state,
      exhaustedUntil: {
        ...this.state.exhaustedUntil,
        [engine]: untilMs,
      },
    }
    await this.persist()
  }

  snapshot(): LedgerState {
    return {
      attempts: this.state.attempts.map((attempt) => ({ ...attempt })),
      exhaustedUntil: { ...this.state.exhaustedUntil },
    }
  }

  // In-memory state is authoritative; writes are chained so two jobs finishing together
  // can't interleave read-modify-write on the file. A failed write rejects its own caller
  // without poisoning the chain for later writes.
  private persist(): Promise<void> {
    const state = this.state
    const write = this.writeChain.then(() => this.writeToDisk(state))
    this.writeChain = write.then(
      () => undefined,
      () => undefined
    )
    return write
  }

  private async writeToDisk(state: LedgerState): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`failed to persist quota ledger to ${this.filePath}: ${detail}`)
    }
  }
}
