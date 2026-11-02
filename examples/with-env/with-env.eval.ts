import { defineEnvironment, evaluate, expect } from 'reeval'

// The sandbox's variables: the agent, setup and the checks all see them. The child keeps
// NODE_ENV and replaces CURRENCY, since env merges by name.
const shop = defineEnvironment('shop', ({ directory }) => ({
  files: directory('./project'),
  env: { NODE_ENV: 'test', CURRENCY: 'USD' },
}))
const shopInEuros = shop.extendEnvironment('shop-eur', { env: { CURRENCY: 'EUR' } })

const prompt = 'Make price() in src/price.js use the currency in the CURRENCY environment variable.'

evaluate('prices in the configured currency', { environments: shopInEuros }, async (c) => {
  await c.send(prompt)

  expect((await c.exec('node bin/price.js 1250')).stdout).toBe('EUR 12.50\n')
  expect((await c.exec('printenv NODE_ENV')).stdout, 'keeps NODE_ENV').toBe('test\n')
  await expect(c.exec('node --test')).toSucceed()
})
