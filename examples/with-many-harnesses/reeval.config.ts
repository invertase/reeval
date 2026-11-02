import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { claudeCode, codex, cursor, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const files = {
  'src/math.js': fakeAgent('src/math.js'),
  'test/math.test.js': fakeAgent('test/math.test.js'),
}

export default defineConfig({
  include: ['*.eval.ts'],
  // Two scripted agents that copy ./fake-agent's files into the workspace, each its own cell, so
  // the checks run without keys or Docker. The second runs the tests first, as a careful agent
  // would.
  harnesses: [
    fakeHarness({ id: 'fake-quick', files }),
    fakeHarness({ id: 'fake-careful', script: [[{ exec: 'node --test' }]], files }),
  ],
  sandbox: fakeSandbox(),
  profiles: {
    // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
    // profiles go beside them.
    ...profiles,
    // Three agents on the same eval: ANTHROPIC_API_KEY, OPENAI_API_KEY and CURSOR_API_KEY.
    agents: {
      defaults: {
        harnesses: [
          claudeCode({ model: 'claude-sonnet-5' }),
          codex({ model: 'gpt-5.6-luna' }),
          cursor({ model: 'composer-2.5' }),
        ],
        sandbox: docker(),
      },
    },
  },
})
