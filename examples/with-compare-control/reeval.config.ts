import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace: offset pages without
  // the skill, cursor pages with it, so the compare shows a difference without keys or Docker.
  harness: fakeHarness({
    files: { 'src/users.js': fakeAgent('without-skill/src/users.js') },
    text: 'listUsers() now takes { offset, limit } and returns one page.',
    withSkill: {
      files: { 'src/users.js': fakeAgent('with-skill/src/users.js') },
      text: 'listUsers() now takes { cursor, limit } and returns { data, nextCursor }.',
    },
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
