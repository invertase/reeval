import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { claudeCode, fakeHarness } from 'reeval/harness'
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
  // One scripted agent at two reasoning efforts, each its own cell. It copies ./fake-agent's
  // files into the workspace, so the checks run without keys or Docker.
  harness: [
    fakeHarness({ effort: 'low', servedModel: 'fake-1[effort=low]', files }),
    fakeHarness({ effort: 'high', servedModel: 'fake-1[effort=high]', files }),
  ],
  sandbox: fakeSandbox(),
  profiles: {
    // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
    // profiles go beside them.
    ...profiles,
    // Claude Code at two efforts: ANTHROPIC_API_KEY.
    'claude-code-efforts': {
      defaults: {
        harness: [
          claudeCode({ model: 'claude-sonnet-5', effort: 'low' }),
          claudeCode({ model: 'claude-sonnet-5', effort: 'high' }),
        ],
        sandbox: docker(),
      },
    },
  },
})
