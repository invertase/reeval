import { evaluate, expect } from 'reeval'
import { sqlite } from './environments.ts'

// A sandbox from a Dockerfile, relative to environments.ts. It starts FROM ${REEVAL_BASE}; from
// any other Debian or Ubuntu base, reeval bakes Node, git and the harness bootstrap on top.
evaluate('queries a seeded SQLite database', { environment: sqlite }, async (c) => {
  await c.send(
    'Load /opt/seed.sql into app.db with sqlite3, then write report.sql that lists customer ' +
      'names alphabetically, one per line.',
  )
  const report = await c.exec('sqlite3 app.db < report.sql')
  await expect(report).toSucceed()
  expect(report.stdout).toBe('Ada\nGrace\nLinus\n')
})
