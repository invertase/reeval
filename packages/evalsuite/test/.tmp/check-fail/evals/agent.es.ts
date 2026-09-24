
import { evaluate, expect } from 'evalsuite'
evaluate('agent eval', async ({ agent, judge, signal }) => {
  const run = await agent.run('write hello.txt')
  await expect(run.exec('echo boom >&2; exit 3')).toSucceed()
})
