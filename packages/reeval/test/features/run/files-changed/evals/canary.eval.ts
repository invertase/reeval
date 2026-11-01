import { evaluate, expect } from 'reeval'

// Must fail: the shell's write is in the diff, so it isn't empty.
evaluate('canary', async (c) => {
  await c.exec("printf 'from the eval\\n' > setup.txt")
  const turn = await c.send('write a note')
  expect(turn.diff.files).toEqual([])
})
