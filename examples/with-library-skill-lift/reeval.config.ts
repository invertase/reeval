import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent/plain's offset-paged handler into the workspace,
  // and ./fake-agent/skill's cursor-paged one when it has the skill, so the compare shows a lift
  // without keys or Docker.
  harness: fakeHarness({
    files: {
      'src/api.js': fakeAgent('plain/src/api.js'),
      'test/api.test.js': fakeAgent('plain/test/api.test.js'),
    },
    text: 'listUsers pages by page and pageSize, with tests.',
    withSkill: {
      files: {
        'src/api.js': fakeAgent('skill/src/api.js'),
        'test/api.test.js': fakeAgent('skill/test/api.test.js'),
      },
      text: 'listUsers pages by cursor as { data, nextCursor }, with tests for both errors.',
    },
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
