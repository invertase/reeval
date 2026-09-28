import { defineConfig } from 'evalsuite'
import { fakeHarness } from 'evalsuite/harness'
import { fakeSandbox } from 'evalsuite/sandbox'

// evals/.history holds a run recorded with `es run --record` at 484bdd8, before the record had
// stack.harnesses[].resolvedModels (#80), evals[].todo (#82) and plan.sandboxWarnings (#100).
// Don't re-record it: it's there to prove records from before those fields still load.
export default defineConfig({
  harness: fakeHarness({ files: { 'greet.js': "export const greet = (n) => 'Hello, ' + n\n" } }),
  sandbox: fakeSandbox(),
})
