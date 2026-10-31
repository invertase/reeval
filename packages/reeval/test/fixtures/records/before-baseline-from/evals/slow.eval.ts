import { evaluate, expect } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Only the budget run records this: reeval run slow --profile budget --concurrency 1.
evaluate(
  'takes its time',
  { harnesses: fakeHarness({ id: 'slow', delayMs: 400, files: { 'greet.js': 'hi\n' } }) },
  async (c) => {
    await c.send('Write greet.js slowly.')
    await expect(c.exec('test -f greet.js')).toSucceed()
  },
)
