import { evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

// A tool the agent needs, baked onto reeval's image once and cached by the exact command list.
// Install commands have no secrets and no workspace; per-attempt steps belong in setup.
const withJq = docker({
  install: [
    'apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*',
  ],
})

evaluate('summarises a JSON file with jq', { sandbox: withJq }, async (c) => {
  await c.send(
    'Write orders.json with five orders (id, customer, total), then count.sh, a bash script that ' +
      'prints the number of orders over 100 using jq. Make it executable.',
  )
  await expect(c.exec('jq --version')).toSucceed()
  await expect(c.exec('./count.sh')).toSucceed()
})
