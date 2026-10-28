import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environment: plain }, async (c) => {
  // The mistake: the build exits 1, and the check, unawaited, still fails the attempt.
  expect(await c.exec('echo broken >&2; exit 1'), 'builds').toSucceed()
})
