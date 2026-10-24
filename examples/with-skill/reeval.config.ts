import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that reads the skill where it's placed (~/.agents/skills, as Cursor's
  // agent reads skills) and copies ./fake-agent's files into the workspace, so the checks run
  // without keys or Docker.
  harness: fakeHarness({
    script: [[{ exec: 'cat ~/.agents/skills/jsdoc/SKILL.md' }]],
    files: { 'src/math.js': fakeAgent('src/math.js') },
    text: 'I added multiply(a, b) to src/math.js, with a JSDoc comment as the jsdoc skill says.',
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
