import { evaluate, expect } from 'reeval'
import { agentSaw, plain } from './env.ts'

// The snapshot is root's, mode 0700: the `reeval` user the agent runs as can't open it.
evaluate('lands', { environments: plain }, async (c) => {
  const [agent] = agentSaw(await c.send('Read the snapshot.'))
  expect(agent?.trim()).toBe('refused')
})
