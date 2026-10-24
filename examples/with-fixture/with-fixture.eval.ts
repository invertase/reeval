import { defineEnvironment, evaluate, expect } from 'reeval'

// The package in ./project without its maintainer notes, a sample file from ./data, and a
// .gitignore, since the project's own isn't copied in.
const csv = defineEnvironment('csv', ({ directory, file }) => ({
  files: {
    ...directory('./project', { glob: ['!NOTES.md'] }),
    'data/people.csv': file('./data/people.csv'),
    '.gitignore': 'node_modules/\n',
  },
}))

evaluate('adds the inverse of parseCsv', { environment: csv }, async (c) => {
  const turn = await c.send(
    'Add stringifyCsv(rows) to src/csv.js, the inverse of parseCsv, ' +
      'with a test that round-trips data/people.csv.',
  )

  await expect(turn).toHaveFile('src/csv.js', /export function stringifyCsv/)
  await expect(c.exec('node --test')).toSucceed()
  expect(c, 'leaves the data alone').not.toHaveChanged(['data/**'])
})
