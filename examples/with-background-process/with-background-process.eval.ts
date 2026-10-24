import { defineEnvironment, evaluate, expect } from 'reeval'

const app = defineEnvironment('server', ({ directory }) => ({ files: directory('./project') }))

evaluate('adds a health route', { environment: app }, async (c) => {
  await c.send('Add a GET /health route to server.js that responds 200 with "ok".')

  const server = await c.exec('node server.js', { background: true })
  // curl retries until the server is listening.
  const health = 'curl -sf --retry 10 --retry-connrefused --retry-delay 1 localhost:4100/health'
  const res = await c.exec(health)
  server.kill()

  await expect(res, 'health responds').toSucceed()
  expect(res.stdout.trim()).toBe('ok')
})
