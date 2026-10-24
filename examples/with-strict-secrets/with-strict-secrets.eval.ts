import { defineEnvironment, evaluate, expect } from 'reeval'

// Brokered, so the config's secrets: { unbrokered: 'error' } accepts it. Without hosts, the
// plan stops. optional: true runs the eval unauthenticated when GITHUB_TOKEN isn't set.
const github = defineEnvironment('github', ({ secret }) => ({
  env: {
    GITHUB_TOKEN: secret.fromEnv('GITHUB_TOKEN', { hosts: secret.hosts.github, optional: true }),
  },
}))

evaluate('reads a repo from the GitHub API', { environment: github }, async (c) => {
  await c.send(
    'Write repo.js, a Node script that prints the description of the nodejs/node GitHub repo ' +
      'from the GitHub API with fetch, sending GITHUB_TOKEN as a bearer token when it is set.',
  )

  const run = await c.exec('node repo.js')
  await expect(run).toSucceed()
  expect(run.stdout).toContain('JavaScript runtime')
})
