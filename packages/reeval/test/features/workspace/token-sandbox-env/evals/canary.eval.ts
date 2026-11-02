import { evaluate, expect } from 'reeval'
import { privateRepo } from './env.ts'

const token = process.env.REEVAL_FIXTURE_GIT_TOKEN as string

// Must fail: the sandbox's processes don't have the token.
evaluate('canary', { environments: privateRepo }, async (c) => {
  const r = await c.exec('env; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n"')
  expect(r.stdout).toContain(token)
})
