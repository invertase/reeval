import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

// Smaller than the defaults (4g, 2 CPUs, 1024 processes). swap: 0 makes 1g the hard ceiling.
const small = defineEnvironment('small', ({ directory }) => ({
  files: directory('./project'),
  sandbox: docker({ memory: '1g', swap: 0, cpus: 1, pids: 256 }),
}))

evaluate('adds multiply on a small machine', { environments: small }, async (c) => {
  await c.send('Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js.')

  await expect(c).toHaveFile('src/math.js', /export function multiply/)
  await expect(c.exec('node --test')).toSucceed()
  const limit = await c.exec('cat /sys/fs/cgroup/memory.max')
  expect(limit.stdout.trim(), 'memory limit').toBe(String(1024 ** 3))
})
