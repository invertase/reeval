import { defineEnvironment, evaluate, expect } from 'reeval'

const env = defineEnvironment('probe', ({ directory }) => ({ files: directory('./project') }))

evaluate('slow install', { environments: [env] }, async (c) => {
  await c.send(
    'Run ./install.sh in the workspace. It takes about 90 seconds. Run it with a short command timeout or in the background, check on it until it finishes, then tell me what done.txt says.',
  )
  await expect(c, 'done').toHaveFile('done.txt', /ok/)
})
