import { defineConfig } from 'evalsuite'
import { antigravity, claudeCode, cursor, fakeHarness } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

// The CLI end to end on a real agent: e2e-real.test.ts records two runs of this one eval and
// reads them back with compare, query, history and studio build. Same rows as the contract
// (ES_CONTRACT_HARNESS, ES_CONTRACT_MODEL); without one, the scripted fake agent.
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
      return fakeHarness({ script: [[{ write: { 'hello.txt': 'hello from es\n' } }]] })
  }
}

export default defineConfig({
  harness: harness(),
  sandbox: docker(),
  runs: 1,
  timeout: '4m',
  budget: { attempts: 1 },
})
