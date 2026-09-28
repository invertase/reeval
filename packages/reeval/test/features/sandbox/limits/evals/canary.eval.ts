import { evaluate, expect } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
import { LIMITS, plain } from './env.ts'

// Must fail: plain docker() has the default limits (4g memory, 1024 processes).
evaluate('canary', { environment: plain, sandbox: docker() }, async (t) => {
  await t.sandbox()
  expect((await t.exec(LIMITS)).stdout).toBe('536870912\n100000 100000\n256\n')
})
