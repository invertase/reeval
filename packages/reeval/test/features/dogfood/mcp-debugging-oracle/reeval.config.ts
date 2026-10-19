import { join } from 'node:path'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

const oracle = `node ${JSON.stringify(join(import.meta.dirname, 'scripts/oracle.mjs'))}`

export default defineConfig({
  harness: fakeHarness({ script: [[{ exec: oracle }]], text: 'Fixed it.' }),
  sandbox: fakeSandbox(),
})
