import { evaluate, expect } from 'reeval'

evaluate('builds the report', { runs: 4 }, async (c) => {
  await c.send('Write build.js, which writes "ok" to dist/report.txt.')
  await c.exec('node build.js', { background: true })
  await c.exec('sleep 1')
  expect(await c.readFile('dist/report.txt'), 'report says ok').toBe('ok\n')
})
