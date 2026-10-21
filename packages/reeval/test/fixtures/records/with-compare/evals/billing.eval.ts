import { defineEnvironment, evaluate, expect } from 'reeval'

const head = process.env.REEVAL_COMPARE_SIDE === 'head'

// Can't compare: the environment's doc changed between the runs, so its fingerprint did too.
const withDoc = defineEnvironment('with-doc', {
  files: { 'docs/billing.md': head ? 'Amounts are in pounds.\n' : 'Amounts are in pence.\n' },
})

evaluate('bills in minor units with the billing doc', { environment: withDoc }, async (c) => {
  await c.send('Bill the customer 12.50 GBP.')
  await expect(c.exec('grep -q pence docs/billing.md'), 'amount in minor units').toSucceed()
})
