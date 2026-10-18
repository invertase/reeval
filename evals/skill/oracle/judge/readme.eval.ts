import { evaluate, expect } from 'reeval'

evaluate('writes the README', async (c) => {
  await c.send('Write README.md for the CLI in cli.js: how to install it and how to run it.')
  await expect(c, 'writes README.md').toHaveFile('README.md', /--help/)
  const q = 'Does README.md explain how to install the CLI and how to run it?'
  expect.soft(await c.judge(q), 'explains usage').toPass()
})
