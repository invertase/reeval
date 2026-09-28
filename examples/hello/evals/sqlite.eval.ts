import { evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

// A sandbox from a Dockerfile, relative to this file. It starts FROM ${REEVAL_BASE}; from any other
// Debian or Ubuntu base, reeval bakes Node, git and the harness bootstrap on top.
evaluate(
  'queries a seeded SQLite database',
  { sandbox: docker({ dockerfile: '../docker/sqlite/Dockerfile' }) },
  async (t) => {
    await t.send(
      'Load /opt/seed.sql into app.db with sqlite3, then write report.sql that lists customer ' +
        'names alphabetically, one per line.',
    )
    const report = await t.exec('sqlite3 app.db < report.sql')
    await expect(report).toSucceed()
    expect(report.stdout).toBe('Ada\nGrace\nLinus\n')
  },
)
