// The project `node scripts/corpus/add.ts <name>` records into a new corpus entry: one run that
// covers what a record can hold (a compare with lift, answered and failed questions, judges that
// pass and fail, a failed check, an infra error, todo and skipped evals, tool calls and
// reasoning), a run that `budget` stops, and a saved analysis.
import { defineConfig, defineEnvironment } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

const greet = "export const greet = (name) => 'Hello, ' + name + '!'\n"

export default defineConfig({
  harness: [
    fakeHarness({
      files: { 'greet.js': greet, 'package.json': '{ "type": "module" }\n' },
      text: 'I wrote greet.js.',
      reasoning: 'The task wants one file.',
      servedModel: 'fake-1[fast=true]',
      tools: [{ tool: 'shell', input: { command: 'ls' }, output: 'package.json' }],
      withSkill: {
        files: { 'greet.js': "export const greet = (name) => 'Ahoy, ' + name + '!'\n" },
        text: 'I wrote greet.js in the house style.',
      },
    }),
    fakeHarness({ id: 'broken', failWith: 'the fake sandbox fell over' }),
  ],
  environment: defineEnvironment('fake', { sandbox: fakeSandbox() }),
  judge: { model: fakeJudge({ score: 0.8 }) },
  analysis: {
    model: fakeAnalysis({
      // Compare questions favour the attempt whose diff greets with Ahoy; one fails at the model.
      vote: (p) => {
        if (p.question.includes('missing name')) throw new Error('Rate limit exceeded (429)')
        return p.a.includes('Ahoy') === p.b.includes('Ahoy')
          ? 'tie'
          : p.a.includes('Ahoy')
            ? 'A'
            : 'B'
      },
      output: (d) => {
        const cites = [d.facts[0]?.id ?? 'F1']
        return {
          tldr: 'The house-style skill lifts the pass rate.',
          whatHappened: [{ text: 'Every eval ran on two harnesses.', cites, confidence: 'high' }],
          results: [
            { text: 'The variant passed where the control failed.', cites, confidence: 'medium' },
          ],
          why: [],
          anomalies: [{ text: 'The broken harness never started.', kind: 'noise', cites }],
          actions: [
            {
              title: 'Rerun the compare',
              target: 'evals/skill.eval.ts',
              kind: 'eval',
              change: 'Run it three times.',
              expectedEffect: 'A tighter interval.',
              verify: 'reeval run skill --runs 3',
              impact: 'medium',
              effort: 'low',
              cites,
            },
          ],
          confidence: { overall: 'medium', why: 'One run.' },
        }
      },
    }),
  },
  profiles: {
    // One at a time (--concurrency 1), each attempt takes 400 ms, so a 1 s budget stops the run
    // before every attempt starts.
    budget: { defaults: { runs: 4 }, budget: { duration: '1s' } },
  },
})
