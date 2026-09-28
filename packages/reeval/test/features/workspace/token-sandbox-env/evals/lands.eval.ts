import { evaluate, expect } from 'evalsuite'
import { privateRepo } from './env.ts'

const token = process.env.ES_FIXTURE_GIT_TOKEN as string

// The token fetched the workspace on the host and never reached the sandbox's processes.
evaluate('lands', { environment: privateRepo }, async (t) => {
  await t.sandbox()
  const r = await t.exec('env; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n"')
  expect(r.stdout).not.toContain(token)
})
