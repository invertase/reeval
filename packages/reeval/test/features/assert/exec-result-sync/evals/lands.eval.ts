import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// An awaited exec result is checked at once: no `await` in front of `expect`.
evaluate('lands', { environment: plain }, async (c) => {
  expect(await c.exec('echo built'), 'builds').toSucceed()
})
