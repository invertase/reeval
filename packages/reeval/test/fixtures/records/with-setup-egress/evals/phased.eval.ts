import { defineEnvironment, evaluate, expect } from 'reeval'
import { docker } from 'reeval/sandbox'

const hold = `const s = require('node:net').connect(Number(new URL(process.env.HTTP_PROXY).port), '127.0.0.1', () =>
  s.write('CONNECT 172.30.0.2:18777 HTTP/1.1\\r\\nHost: 172.30.0.2:18777\\r\\n\\r\\n'),
)
s.on('data', () => require('node:fs').writeFileSync('tunnel.txt', 'open'))
s.on('error', () => {})
`

const phased = defineEnvironment('phased', {
  sandbox: docker(),
  egress: { setup: { allow: ['172.30.0.2'] }, agent: 'deny-all' },
  files: { 'hold.cjs': hold },
  setup: [
    { run: 'curl -sS -m 10 -o /dev/null http://172.30.0.2:18777/' },
    {
      run: 'setsid nohup node hold.cjs > /dev/null 2>&1 < /dev/null & for i in $(seq 50); do [ -s tunnel.txt ] && break; sleep 0.2; done',
    },
  ],
})

// Setup contacts the listener and leaves a tunnel open; the agent's deny-all refuses both of its
// requests and closes the tunnel.
evaluate('phased', { environments: phased }, async (c) => {
  const turn = await c.send('reach both hosts')
  expect(turn.transcript.some((e) => e.type === 'tool')).toBe(true)
})
