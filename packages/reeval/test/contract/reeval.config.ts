import { defineConfig } from 'reeval'
import { openrouter, vercel, vertex } from 'reeval/gateway'
import { boat } from 'reeval/sandbox/boat'
import { contractHarness } from './harness.ts'

// The harness contract: every real harness runs these evals in Docker, in boat() with
// REEVAL_CONTRACT_SANDBOX=boat, or in boat() with an image recipe with boat-image. contract.test.ts
// picks the harness, model and gateway (REEVAL_CONTRACT_HARNESS, REEVAL_CONTRACT_MODEL,
// REEVAL_CONTRACT_GATEWAY) from its table.
export default defineConfig({
  harnesses: contractHarness(),
  ...(process.env.REEVAL_CONTRACT_SANDBOX === 'boat'
    ? { sandbox: boat(), egress: 'allow-all' as const }
    : {}),
  ...(process.env.REEVAL_CONTRACT_SANDBOX === 'boat-image'
    ? { sandbox: boat({ from: 'debian:bookworm-slim', id: 'boat-image' }) }
    : {}),
  // REEVAL_CONTRACT_GATEWAY: the row's gateway alone, so the plan refuses rather than falls back.
  ...(process.env.REEVAL_CONTRACT_GATEWAY === 'vercel' ? { gateway: [vercel()] } : {}),
  ...(process.env.REEVAL_CONTRACT_GATEWAY === 'openrouter' ? { gateway: [openrouter()] } : {}),
  ...(process.env.REEVAL_CONTRACT_GATEWAY === 'vertex' ? { gateway: [vertex()] } : {}),
  // No retries, one attempt per cell: a failure is a failure (see README, flake policy).
  runs: 1,
  timeout: '4m',
  // The hard cap: the 26 evals in evals/, and nothing a stray eval file could add.
  budget: { attempts: 26 },
})
