import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

// evals/.history holds a run recorded with `reeval run --record` at 484bdd8, before the record had
// stack.harnesses[].resolvedModels (#80), evals[].todo (#82) and plan.sandboxWarnings (#100).
// Don't re-record it: it's there to prove records from before those fields still load.
export default defineConfig({
  harness: fakeHarness({ files: { 'greet.js': "export const greet = (n) => 'Hello, ' + n\n" } }),
  sandbox: fakeSandbox(),
  // Its evals keep the names their records were made under.
  include: ['evals/**/*.es.ts'],
})
