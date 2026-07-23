import type { Effort, EngineName } from '../types'
import type { Policy } from './policy'
import type { QuotaLedger } from './quota'

export function resolveWorkerModel(
  policy: Policy,
  engine: EngineName,
  effort?: Effort,
): string | undefined {
  const worker = policy.workers[engine]
  const tier = effort ?? 'standard'
  return worker.models?.[tier] ?? worker.model
}

export function resolveWorkerReasoning(
  policy: Policy,
  engine: EngineName,
  effort?: Effort,
): string | undefined {
  const reasoning = policy.workers[engine].reasoning
  if (typeof reasoning === 'string') return reasoning
  return reasoning?.[effort ?? 'standard']
}

/**
 * First non-excluded engine in policy.chain with quota headroom, or null when every
 * eligible engine is exhausted/capped (caller surfaces the appropriate capacity error).
 * Duplicate chain entries are tolerated (first hit wins).
 *
 * Pure selection by design: the executor records outcomes and marks exhaustion
 * on the ledger, so a failing engine drops out on the next call without any
 * router-held state.
 */
export function selectEngine(
  policy: Policy,
  ledger: QuotaLedger,
  exclude?: EngineName,
): EngineName | null {
  const available = policy.chain.find(
    (engine) => engine !== exclude && ledger.hasHeadroom(engine, policy.quotas[engine]),
  )
  return available ?? null
}
