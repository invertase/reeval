import { evaluate, expect } from 'reeval'

evaluate('reads the docs before it answers', async (c) => {
  const turn = await c.send(
    'Search the web for the Node.js docs on util.parseArgs(), read the page, and write ' +
      'the Node.js version that added it in ANSWER.md.',
  )

  expect.soft(turn, 'searched').toHaveSearched(/parseArgs/i)
  expect.soft(turn, 'read the docs').toHaveFetched(/nodejs\.org/)
  await expect(c, 'answer').toHaveFile('ANSWER.md', /18\.3\.0|16\.17\.0/)
})
