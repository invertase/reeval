import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

// The Dockerfile path is relative to this file. Its image has sqlite3 and a seeded /opt/shop.db.
const shop = defineEnvironment('shop', {
  sandbox: docker({ dockerfile: './sqlite/Dockerfile' }),
})

evaluate('queries the seeded database', { environment: shop }, async (c) => {
  await c.send(
    'Write report.sql, a query on /opt/shop.db that lists the customer names alphabetically.',
  )

  const report = await c.exec('sqlite3 /opt/shop.db < report.sql')
  await expect(report).toSucceed()
  expect(report.stdout).toBe('Ada\nGrace\nLinus\n')
})
