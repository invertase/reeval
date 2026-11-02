import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')
const turn = (n: number) => ({
  write: {
    'src/math.js': fakeAgent(`turn-${n}/src/math.js`),
    'test/math.test.js': fakeAgent(`turn-${n}/test/math.test.js`),
  },
})

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that writes ./fake-agent/turn-1 on the first turn and turn-2 on the
  // second, so the checks run without keys or Docker.
  harnesses: fakeHarness({
    script: [
      [turn(1), { reply: 'I added multiply(a, b) to src/math.js and a test for it.' }],
      [turn(2), { reply: 'multiply now takes any number of arguments, with a test.' }],
    ],
  }),
  sandbox: fakeSandbox(),
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
