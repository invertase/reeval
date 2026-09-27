import { evaluate, expect } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
import { agentSaw, plain } from './env.ts'

// Must fail: with docker({ root: true }) both run as root, with the capabilities apt-get needs.
evaluate('canary', { environment: plain, sandbox: docker({ root: true }) }, async (t) => {
  const [agent] = agentSaw(await t.send('who are you'))
  const check = (await t.exec('id -u')).stdout
  expect(`${agent?.trim()} / ${check.trim()}`).toBe('10001 0000000000000000 / 10001')
})
