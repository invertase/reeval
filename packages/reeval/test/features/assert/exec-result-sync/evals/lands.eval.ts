import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

// An awaited exec result is checked at once, with no `await` in front of `expect`, and names its
// command in the default label.
evaluate('lands', { environments: plain }, async (c) => {
  expect(await c.exec('echo built')).toSucceed()
})
