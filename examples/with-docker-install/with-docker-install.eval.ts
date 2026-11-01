import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

// jq is baked onto reeval's image once, and the image is cached by the exact command list.
const withJq = defineEnvironment('jq', ({ directory }) => ({
  files: directory('./project'),
  sandbox: docker({
    install: [
      'apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*',
    ],
  }),
}))

evaluate('counts the large orders with jq', { environments: withJq }, async (c) => {
  await c.send(
    'Write count.sh, a bash script that prints how many orders in orders.json have a total over 100, using jq.',
  )

  await expect(c.exec('jq --version')).toSucceed()
  expect((await c.exec('bash count.sh')).stdout.trim()).toBe('2')
})
