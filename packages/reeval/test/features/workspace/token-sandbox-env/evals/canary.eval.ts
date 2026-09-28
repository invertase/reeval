import { evaluate, expect } from 'evalsuite'
import { privateRepo } from './env.ts'

const token = process.env.ES_FIXTURE_GIT_TOKEN as string

// Must fail: the sandbox's processes don't have the token.
evaluate('canary', { environment: privateRepo }, async (t) => {
  await t.sandbox()
  const r = await t.exec('env; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n"')
  expect(r.stdout).toContain(token)
})
