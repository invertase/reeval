import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { direct, vercel } from 'reeval/gateway'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // Model calls go through Vercel AI Gateway on AI_GATEWAY_API_KEY wherever it serves the
  // harness or judge model, and fall back to each one's own key where it can't (Cursor, pi).
  gateway: [vercel(), direct()],
  // A scripted agent that copies ./fake-agent's files into the workspace, so the checks run
  // without an agent's key or Docker. The judge is real: see with-vercel-gateway.eval.ts.
  harness: fakeHarness({
    files: {
      'src/math.js': fakeAgent('src/math.js'),
      'test/math.test.js': fakeAgent('test/math.test.js'),
    },
    text: 'I added multiply(a, b) to src/math.js and a test for it.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
