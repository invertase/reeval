
import { evaluate, expect } from 'evalsuite'
evaluate('agent eval', async ({ agent, judge, signal }) => {
  const run = await agent.run('write hello.txt')
  expect(await judge(run, 'ok?')).toPass()
})
