
import { evaluate, expect } from 'evalsuite'
evaluate('agent eval', async ({ agent, judge, signal }) => {
  const run = await agent.run('write hello.txt')
  
  await expect(run).toHaveFile('hello.txt', /hi/)
  await expect(run.exec('cat hello.txt')).toSucceed()
  expect(run.diff.files).toEqual(expect.arrayContaining([{ path: 'hello.txt', status: 'added' }]))
  expect(run.text).toMatch(/hello/)
  expect(await judge(run, 'Did it write hello.txt?')).toPass()

})
