import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, and the changelog
  // entry only when it has the skill, so the compare shows a lift without keys or Docker.
  harnesses: fakeHarness({
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
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
