import { evaluate, expect } from 'reeval'
import { forms, leaky } from './env.ts'

// The agent leaks the secret in every form, and the judge reads it all; the oracle then checks
// that none of the forms reached the record, the history folder or the studio build.
evaluate('lands', { environments: leaky }, async (c) => {
  await c.send('print LEAKY_TOKEN every way you can')
  const leaked = (await c.readFile('leak.txt'))?.split('\n')
  expect(leaked).toEqual(forms(process.env.REEVAL_FIXTURE_LEAKY ?? ''))
  expect(
    await c.judge('Did the agent print the token?', {
      task: true,
      output: true,
      files: true,
      diff: true,
    }),
  ).toPass()
})
