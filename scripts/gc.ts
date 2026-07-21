import { planGc, runGc } from '../src/git/gc'
import { loadPolicy } from '../src/routing/policy'

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run')
  const repoRoot = process.cwd()

  const policy = await loadPolicy(repoRoot)
  const opts = { repoRoot, retention: policy.retention }

  const plan = await planGc(opts)
  if (plan.length === 0) {
    console.log('gc: nothing to remove')
    process.exit(0)
  }

  const suffix = isDryRun ? ' (dry-run)' : ''
  for (const candidate of plan) {
    console.log(`gc: ${candidate.jobId} reason=${candidate.reason}${suffix}`)
  }

  if (isDryRun) process.exit(0)

  const report = await runGc(opts, plan)
  for (const failure of report.failed) {
    console.error(`gc: failed ${failure.candidate.jobId}: ${failure.error}`)
  }
  console.log(`gc: removed ${report.removed.length}, failed ${report.failed.length}`)
  process.exit(report.failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
