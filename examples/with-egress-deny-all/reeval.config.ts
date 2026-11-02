import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that tries the npm registry first, as an agent looking for a package
  // might, then writes ./fake-agent's files into the workspace.
  harnesses: fakeHarness({
    script: [
      [
        { exec: 'curl -sS https://registry.npmjs.org/left-pad' },
        {
          write: {
            'src/math.js': fakeAgent('src/math.js'),
            'test/math.test.js': fakeAgent('test/math.test.js'),
          },
        },
        { reply: 'I added multiply(a, b) to src/math.js and a test for it.' },
      ],
    ],
  }),
  // fakeSandbox() can't enforce an egress policy, so the plan refuses deny-all on it.
  sandbox: docker(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
