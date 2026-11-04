import { evaluate, expect } from 'reeval'
import { plain } from './env.ts'

evaluate('canary', { environments: plain }, async (c) => {
  const turn = await c.send('print the contract token')
  // The command line contains "deploy", but no segment runs a program named deploy.
  expect(turn).toHaveRun({ program: 'deploy' })
})
