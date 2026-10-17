import { defineConfig } from 'reeval'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fakeHarness,
  goose,
  opencode,
  pi,
} from 'reeval/harness'

// The CLI end to end on a real agent: e2e-real.test.ts records two runs of this one eval and
// reads them back with compare, query, history and studio build. Same rows as the contract
// (REEVAL_CONTRACT_HARNESS, REEVAL_CONTRACT_MODEL); without one, the scripted fake agent.
const model = process.env.REEVAL_CONTRACT_MODEL ?? ''
const harness = () => {
  switch (process.env.REEVAL_CONTRACT_HARNESS) {
    case 'cursor':
      // fast=false: the cheaper variant; an unset parameter takes the catalog's default (fast=true).
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
    default:
      return fakeHarness({ script: [[{ write: { 'hello.txt': 'hello from reeval\n' } }]] })
  }
}

export default defineConfig({
  harness: harness(),
  runs: 1,
  timeout: '4m',
  budget: { attempts: 1 },
})
