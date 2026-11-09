import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Each slot is its own user, with its own workspace, home and gateway port: slot 0 is the layout
// a machine of its own has, slot 1 the same names with -s1, and each sees its home at slot 0's.
evaluate('lands', { environments: vm }, async (c) => {
  const [user, cwd, home, proxy] = agentSaw(await c.send('where am I'))
  const slot = user === 'reeval' ? 0 : 1
  const s = slot ? '-s1' : ''
  expect([user, cwd, home, proxy]).toEqual([
    `reeval${s}`,
    `/reeval${s}/workspace`,
    '/home/reeval',
    `http://127.0.0.1:${43128 + slot}`,
  ])
})
