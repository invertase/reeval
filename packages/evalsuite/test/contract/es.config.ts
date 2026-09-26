import { defineConfig } from 'evalsuite'
import { antigravity, claudeCode, cursor, fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'
import { fakeScript } from './evals/probes.ts'

// The harness contract: every real harness runs these evals in Docker. contract.test.ts picks the
// harness and model (ES_CONTRACT_HARNESS, ES_CONTRACT_MODEL) from its table; without one it's the
// scripted fake agent with Cursor's layout, the key-free row that checks the suite itself.
const model = process.env.ES_CONTRACT_MODEL ?? ''
const harness = () => {
  switch (process.env.ES_CONTRACT_HARNESS) {
    case 'cursor':
      return cursor({ model })
    case 'antigravity':
      return antigravity({ model })
    case 'claude-code':
      return claudeCode({ model })
    default:
      return fakeHarness({ layout: 'cursor', script: [fakeScript] })
  }
}

export default defineConfig({
  harness: harness(),
  sandbox: docker(),
  // No retries, one attempt per cell: a failure is a failure (see README, flake policy).
  runs: 1,
  timeout: '4m',
  // The hard cap: the 12 evals below, and nothing a stray eval file could add.
  budget: { attempts: 12 },
})
