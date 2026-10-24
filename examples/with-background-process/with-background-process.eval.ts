import { defineEnvironment, evaluate, expect } from 'reeval'

// The agent's commands and the checks both see PORT.
const app = defineEnvironment('server', ({ directory }) => ({
  files: directory('./project'),
  env: { PORT: '4100' },
}))

evaluate('adds a health route', { environment: app }, async (c) => {
  await c.send('Add a GET /health route to server.js that responds 200 with "ok".')

  const server = await c.exec('node server.js', { background: true })
  // curl retries until the server is listening.
  const health = 'curl -sf --retry 10 --retry-connrefused --retry-delay 1 "localhost:$PORT/health"'
  const res = await c.exec(health)
  server.kill()

  await expect(res, 'health responds').toSucceed()
  expect(res.stdout.trim()).toBe('ok')
})
