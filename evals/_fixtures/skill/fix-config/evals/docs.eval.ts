import { evaluate, expect } from 'reeval'
import { plain, withDocs } from './environments.ts'

evaluate('answers from the docs', { environment: [plain, withDocs], repeat: 3 }, async (c) => {
  await c.send('How do I page through GET /notes? Write the answer to answer.md.')
  expect(c, 'names the parameter').toHaveFile('answer.md', /limit/)
  expect(await c.judge('Does answer.md say how to page through /notes?')).toPass()
})
