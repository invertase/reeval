import { evaluate, expect, group } from 'reeval'

const joinsRows = `node -e "import('./lib/export.js').then((m) =>
  process.exit(m.toCsv([['a', 'b'], ['c', 'd']]) === 'a,b\\nc,d' ? 0 : 1))"`

group('modules', { runs: 2 }, () => {
  evaluate('writes the CSV export', async (c) => {
    const turn = await c.send(
      'Write lib/export.js exporting toCsv(rows), joining rows with commas.',
    )
    await expect.soft(turn, 'export.js exists').toHaveFile('lib/export.js', /toCsv/)
    await expect.soft(c.exec(joinsRows), 'joins rows').toSucceed()
  })
})
