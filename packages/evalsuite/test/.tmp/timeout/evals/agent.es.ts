
import { evaluate, expect } from 'evalsuite'
evaluate('agent eval', { timeout: '1s' }, async ({ agent, judge, signal }) => {
  const run = await agent.run('write hello.txt')
  
})
