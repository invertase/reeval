import { evaluate, expect } from 'reeval'

// SSH is raw TCP, which the gateway can't carry: under every other policy the container has no
// network of its own. allow-all keeps it, unfiltered and unrecorded, so set it on this eval only.
evaluate('reads an SSH banner over raw TCP', { egress: 'allow-all' }, async (c) => {
  await c.send(
    "Write banner.sh, a bash script that prints the first line github.com's SSH server sends on " +
      'port 22, using /dev/tcp.',
  )

  const run = await c.exec('bash banner.sh')
  await expect(run).toSucceed()
  expect(run.stdout).toMatch(/^SSH-2\.0-/)
})
