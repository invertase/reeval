import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { claudeCode, fakeHarness } from 'reeval/harness'
import { docker, fakeSandbox } from 'reeval/sandbox'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, and the changelog entry only when it has
  // the skill, so the compare shows a lift without keys or Docker.
  harness: fakeHarness({
    files: { 'src/math.js': fakeAgent('src/math.js') },
    text: 'I added multiply(a, b) to src/math.js.',
    withSkill: {
      files: {
        'src/math.js': fakeAgent('src/math.js'),
        'CHANGELOG.md': fakeAgent('CHANGELOG.md'),
      },
      text: 'I added multiply(a, b) to src/math.js and recorded it in CHANGELOG.md.',
    },
  }),
  sandbox: fakeSandbox(),
  profiles: {
    // The same compare on a real agent in Docker: needs ANTHROPIC_API_KEY and
    // `reeval image build --profile claude-code` once.
    'claude-code': {
      defaults: { harness: claudeCode({ model: 'claude-sonnet-5' }), sandbox: docker() },
    },
  },
})
