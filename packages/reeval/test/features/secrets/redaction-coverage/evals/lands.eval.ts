import { evaluate, expect } from 'evalsuite'
import { forms, leaky } from './env.ts'

// The agent leaks the secret in every form, and the judge reads it all; the oracle then checks
// that none of the forms reached the record, the history folder or the studio build.
evaluate('lands', { environment: leaky }, async (t) => {
  await t.send('print LEAKY_TOKEN every way you can')
  const leaked = (await t.readFile('leak.txt'))?.split('\n')
  expect(leaked).toEqual(forms(process.env.ES_FIXTURE_LEAKY ?? ''))
  expect(await t.judge('Did the agent print the token?')).toPass()
})
