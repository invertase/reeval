// The project behind the compare goldens' `with-compare` corpus entry: two runs of the same evals,
// the second with REEVAL_COMPARE_SIDE=head, so `reeval compare` has an eval that regressed, one
// that's fixed, one that can't be compared, a new and a removed one, and some that stayed the same.
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness({
    files: { 'greet.js': "const greet = (name) => 'Hello, ' + name + '!'\n" },
    text: 'I wrote greet.js.',
  }),
  sandbox: fakeSandbox(),
})
