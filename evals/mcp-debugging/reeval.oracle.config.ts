// Checks the eval itself, with no keys or Docker: the oracle fixes every fixture and must pass,
// `--profile canary` skips the failing eval instead and must fail, and `--profile mcp` also calls
// reeval mcp from the variant (filter to `with-mcp`: the control has no server to call).
import { join } from 'node:path'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

const oracle = `node ${JSON.stringify(join(import.meta.dirname, 'scripts/oracle.mjs'))}`

export default defineConfig({
  include: ['*.eval.ts'],
  harness: fakeHarness({ script: [[{ exec: oracle }]], text: 'Fixed it.' }),
  sandbox: fakeSandbox(),
  profiles: {
    canary: {
      defaults: { harness: fakeHarness({ script: [[{ exec: `${oracle} --cheat` }]] }) },
    },
    mcp: {
      defaults: {
        harness: fakeHarness({
          script: [[{ mcp: 'reeval/failures' }, { exec: oracle }]],
        }),
      },
    },
  },
})
