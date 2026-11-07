import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// Must fail: the copy of another slot's install names this slot's home, not the installer's.
evaluate('canary', { environments: vm }, async (c) => {
  const [installed = '', , , home] = agentSaw(await c.send('who installed me?'))
  expect(installed.split(' ')[1]).not.toBe(home)
})
