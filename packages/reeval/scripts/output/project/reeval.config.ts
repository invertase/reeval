// The project behind the output goldens' `with-layouts` and `with-insights` corpus entries: one
// file per layout (results, choose a tool, measure a change, compare harnesses, both, a family and
// a family with a change), on the fake harness and sandbox, so it records with no keys. Its fake
// analysis model writes `reeval analyze --insights`'s sentences from the facts (insights.ts).
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
import { insights } from './insights.ts'

const greet = "const greet = (name) => 'Hello, ' + name + '!'\n"
const ahoy = "const greet = (name) => 'Ahoy, ' + name + '!'\n"

export default defineConfig({
  harness: fakeHarness({
    files: { 'greet.js': greet },
    text: 'I wrote greet.js.',
    tools: [{ tool: 'shell', input: { command: 'ls' }, output: 'greet.js' }],
    withSkill: { files: { 'greet.js': ahoy }, text: 'I wrote greet.js in the house style.' },
  }),
  sandbox: fakeSandbox(),
  analysis: { model: fakeAnalysis({ insights }) },
})
