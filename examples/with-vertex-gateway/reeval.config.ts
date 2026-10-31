import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { vertex } from 'reeval/gateway'
import { claudeCode, fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { docker, fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, so the checks run
  // without keys or Docker.
  harnesses: fakeHarness({
    files: {
      'src/math.js': fakeAgent('src/math.js'),
      'test/math.test.js': fakeAgent('test/math.test.js'),
    },
    text: 'I added multiply(a, b) to src/math.js and a test for it.',
  }),
  sandbox: fakeSandbox(),
  // A fixed score and no model call; each profile sets its own judge model, which wins.
  judge: { model: fakeJudge({ score: 0.9 }) },
  profiles: {
    // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
    // profiles go beside them.
    ...profiles,
    // Claude Code and its judge on Vertex AI, billed to GOOGLE_CLOUD_PROJECT, with a token from
    // the host's Application Default Credentials and no key at all. With vertex() alone in the
    // list, a harness or model Vertex can't serve stops the plan instead of falling back to its
    // own key. The Anthropic API's dated id is sent to Vertex as claude-haiku-4-5@20251001.
    vertex: {
      defaults: {
        harnesses: claudeCode({ model: 'claude-haiku-4-5-20251001' }),
        sandbox: docker(),
      },
      judge: { model: 'anthropic/claude-haiku-4-5-20251001' },
      gateway: [vertex()],
    },
  },
})
