import { evaluate, expect } from 'reeval'

// A file the shell wrote is in the workspace diff, though no edit tool touched it. The eval's own
// write before the turn is in the diff too, but not in the turn's files changed.
evaluate('lands', async (c) => {
  await c.exec("printf 'from the eval\\n' > setup.txt")
  const turn = await c.send('write a note')
  expect(turn.diff.files).toEqual([
    { path: 'note.txt', status: 'added' },
    { path: 'setup.txt', status: 'added' },
  ])
})
