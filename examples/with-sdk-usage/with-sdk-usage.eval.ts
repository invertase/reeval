import { readFileSync } from 'node:fs'
import { defineEnvironment, evaluate, expect } from 'reeval'

// An empty package with the Acme SDK seeded into vendor/acme.
const app = defineEnvironment('acme-app', ({ directory }) => ({
  files: { ...directory('./project'), ...directory('./acme-sdk', { into: 'vendor/acme' }) },
}))
const checkClient = readFileSync(new URL('./hidden/check-client.mjs', import.meta.url), 'utf8')

evaluate('uses the Acme SDK correctly', { environments: app }, async (c) => {
  await c.send(
    'Write src/forecast.js exporting forecast(city), which resolves to the temperature in ' +
      'Celsius from the Acme SDK in vendor/acme (see its README.md), with the key in ' +
      'ACME_API_KEY. The API sometimes answers 503; retry those.',
  )

  await c.writeFile('check-client.mjs', checkClient)
  await expect(c.exec('node check-client.mjs')).toSucceed()
  const question = 'Does forecast() use client.retry rather than its own loop?'
  expect(await c.judge(question, { contents: ['src/forecast.js'] })).toPass()
})
