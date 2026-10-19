import { evaluate, expect, group } from 'reeval'

group('report', { runs: 6 }, () => {
  evaluate('builds the report', async (c) => {
    await c.send('Write build.js, which writes "ok" to dist/report.txt.')
    await c.exec('node build.js', { background: true })
    await c.exec('sleep 0.2')
    expect.soft(await c.readFile('dist/report.txt'), 'report says ok').toBe('ok\n')
  })
})
