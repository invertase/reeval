import { evaluate, expect } from 'reeval'
import { agentSaw, vm } from './env.ts'

// The agent runs as reeval in the workspace, on its own copy of the VM's Node, behind the gateway.
evaluate('lands', { environments: vm }, async (c) => {
  expect(agentSaw(await c.send('where am I')).slice(0, 4)).toEqual([
    'reeval',
    '/reeval/workspace',
    '/opt/reeval/node/bin/node',
    'http://127.0.0.1:24128',
  ])
})
