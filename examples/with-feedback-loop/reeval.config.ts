import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const turn = (n: number) => ({
  'src/notes.js': fakeAgent(`turn-${n}/src/notes.js`),
  'test/notes.test.js': fakeAgent(`turn-${n}/test/notes.test.js`),
})

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent/turn-1 into the workspace on the first turn and
  // ./fake-agent/turn-2 on the second, and a judge with a fixed score, so the checks run without
  // keys or Docker.
  harnesses: fakeHarness({
    script: [
      [{ write: turn(1) }, { reply: 'listNotes({ page }) returns ten notes a page, with a test.' }],
      [{ write: turn(2) }, { reply: 'listNotes({ cursor }) pages by cursor now; tests updated.' }],
    ],
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
