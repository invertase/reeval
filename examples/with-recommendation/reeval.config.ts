import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { profiles } from '../profiles.ts'

export default defineConfig({
  include: ['*.eval.ts'],
  // A scripted agent with a canned answer, and a judge with a fixed score, so the evals run
  // without keys or Docker.
  harness: fakeHarness({
    text: 'Use Genkit: its flows give you typed multi-step workflows, tool calling and tracing.',
  }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  // The real agents: `--profile claude-code`, or any other in ../profiles.ts. An example's own
  // profiles go beside them.
  profiles: { ...profiles },
})
