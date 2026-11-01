import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that reads the skill's SKILL.md, but not its reference, then copies
  // ./fake-agent's files into the workspace, so the skill's reads show without keys.
  harnesses: fakeHarness({
    script: [[{ exec: 'cat ~/.agents/skills/jsdoc/SKILL.md' }]],
    files: { 'src/math.js': fakeAgent('src/math.js') },
    text: 'I added multiply(a, b) to src/math.js, with a JSDoc block.',
  }),
  // Docker, not the fake sandbox: only there does reeval list the files the skill placed.
  sandbox: docker(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
