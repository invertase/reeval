import { join } from 'node:path'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

// The agent under test: it writes what agent/ holds, so a change there is a change in the
// agent's behaviour, not in the evals.
const agent = JSON.stringify(join(import.meta.dirname, 'agent'))

export default defineConfig({
  harness: fakeHarness({ script: [[{ exec: `cp -R ${agent}/. .` }]], text: 'Done.' }),
  sandbox: fakeSandbox(),
})
