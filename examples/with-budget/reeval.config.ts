import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace, taking six seconds a
  // turn, so the run reaches its duration budget without keys or Docker.
  harnesses: fakeHarness({
    files: {
      'src/math.js': fakeAgent('src/math.js'),
      'test/math.test.js': fakeAgent('test/math.test.js'),
    },
    text: 'I added multiply(a, b) to src/math.js and a test for it.',
    delayMs: 6000,
  }),
  sandbox: fakeSandbox(),
  // One attempt at a time, so the two seconds end during the first attempt: the rest, queued
  // until it finishes at six seconds or more, are skipped.
  concurrency: 1,
  budget: { attempts: 10, duration: '2s' },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
