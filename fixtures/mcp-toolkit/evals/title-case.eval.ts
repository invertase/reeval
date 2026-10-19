import { evaluate, expect } from 'reeval'

evaluate('title-cases a phrase', async (c) => {
  await c.send('Write src/title-case.js: titleCase(s) capitalises each word.')
  expect
    .soft(await c.readFile('src/title-case.js'), 'upper-cases each first letter')
    .toContain('toUpperCase()')
})
