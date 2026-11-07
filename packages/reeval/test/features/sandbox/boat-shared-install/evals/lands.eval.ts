import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Whichever slot installed, the agent's home has the install as its own: its files are its
// user's and name its home. The row's record check holds that the bootstrap ran once.
evaluate('lands', { environments: vm }, async (c) => {
  const [installed = '', owner, user, home] = agentSaw(await c.send('who installed me?'))
  expect([installed.split(' ')[1], owner]).toEqual([home, user])
})
