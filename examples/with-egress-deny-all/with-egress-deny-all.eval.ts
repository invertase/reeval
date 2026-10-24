import { defineEnvironment, evaluate, expect } from 'reeval'

const math = defineEnvironment('math', ({ directory }) => ({ files: directory('./project') }))

// deny-all still lets through what the attempt needs: the harness's API, brokered secrets'
// hosts and MCP servers' hosts. Every other request gets a 403 from the gateway and is recorded.
evaluate('adds multiply with no network', { environment: math, egress: 'deny-all' }, async (c) => {
  await c.send(
    'Add a multiply(a, b) function to src/math.js, with a test in test/math.test.js. ' +
      'Use no packages from npm.',
  )

  await expect(c.exec('node --test')).toSucceed()
  expect((await c.exec('curl -sS https://registry.npmjs.org/')).exitCode, 'offline').not.toBe(0)
})
