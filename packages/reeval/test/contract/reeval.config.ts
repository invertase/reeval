import { defineConfig } from 'reeval'
import { openrouter, vercel, vertex } from 'reeval/gateway'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fakeHarness,
  fx,
  goose,
  grokBuild,
  opencode,
  pi,
} from 'reeval/harness'
import { fakeScript } from './evals/probes.ts'

// The harness contract: every real harness runs these evals in Docker. contract.test.ts picks the
// harness, model and gateway (REEVAL_CONTRACT_HARNESS, REEVAL_CONTRACT_MODEL,
// REEVAL_CONTRACT_GATEWAY) from its table; without one it's the
// scripted fake agent with Cursor's layout, the key-free row that checks the suite itself.
const model = process.env.REEVAL_CONTRACT_MODEL ?? ''
const harness = () => {
  switch (process.env.REEVAL_CONTRACT_HARNESS) {
    case 'cursor':
      // fast=false: the standard-priced variant, pinned though it is the default.
      return cursor({ model, params: { fast: 'false' } })
    case 'antigravity':
      return antigravity({ model })
    case 'claude-code':
      return claudeCode({ model })
    case 'opencode':
      return opencode({ model })
    case 'goose':
      return goose({ model })
    case 'pi':
      return pi({ model })
    case 'codex':
      return codex({ model })
    case 'grok-build':
      return grokBuild({ model })
    case 'fx':
      return fx({ model })
    default:
      return fakeHarness({ layout: 'cursor', script: [fakeScript] })
  }
}

export default defineConfig({
  harness: harness(),
  // REEVAL_CONTRACT_GATEWAY: the row's gateway alone, so the plan refuses rather than falls back.
  ...(process.env.REEVAL_CONTRACT_GATEWAY === 'vercel' ? { gateway: [vercel()] } : {}),
  ...(process.env.REEVAL_CONTRACT_GATEWAY === 'openrouter' ? { gateway: [openrouter()] } : {}),
  ...(process.env.REEVAL_CONTRACT_GATEWAY === 'vertex' ? { gateway: [vertex()] } : {}),
  // No retries, one attempt per cell: a failure is a failure (see README, flake policy).
  runs: 1,
  timeout: '4m',
  // The hard cap: the 22 evals in evals/, and nothing a stray eval file could add.
  budget: { attempts: 22 },
})
