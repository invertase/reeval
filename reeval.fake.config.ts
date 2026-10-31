// The same evals with no key, Docker or model: a fake agent that changes nothing, so every check
// that reads the agent's work should fail. A topic's own fake configs hold its oracle.
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ['evals/*/*.eval.ts'],
  harnesses: fakeHarness({ text: 'I left the workspace as it was.' }),
  sandbox: fakeSandbox(),
  judge: { model: fakeJudge({ score: 0.9 }) },
  analysis: { model: fakeAnalysis({ vote: 'tie' }) },
  timeout: '10m',
})
