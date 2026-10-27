import { readFileSync } from 'node:fs'
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

const fakeAgent = (path: string) =>
  readFileSync(new URL(`./fake-agent/${path}`, import.meta.url), 'utf8')

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent that copies ./fake-agent's files into the workspace: both arms throw for a
  // zero divisor, and only the one with the skill names the argument.
  harness: fakeHarness({
    files: { 'src/math.js': fakeAgent('without-skill/src/math.js') },
    text: 'I added divide(a, b) to src/math.js.',
    withSkill: {
      files: { 'src/math.js': fakeAgent('with-skill/src/math.js') },
      text: 'I added divide(a, b) to src/math.js; it throws a RangeError when b is 0.',
    },
  }),
  sandbox: fakeSandbox(),
  // The model that answers the questions. This fake votes for the side whose diff names
  // the argument; set a real one, such as 'anthropic/claude-sonnet-5', for real votes.
  analysis: {
    model: fakeAnalysis({ vote: (pair) => (pair.a.diff?.includes('b must') ? 'A' : 'B') }),
  },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
