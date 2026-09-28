import { evaluate, expect } from 'evalsuite'

evaluate('writes hello.txt', async (t) => {
  const turn = await t.send(
    'Run `ls -a` to look around, then create hello.txt containing exactly: hi',
  )
  await expect(turn).toHaveFile('hello.txt', /hi/)
  await expect(t.exec('grep -qx hi hello.txt')).toSucceed()
  expect(await t.judge('Did the agent create hello.txt containing hi?')).toPass()
})
