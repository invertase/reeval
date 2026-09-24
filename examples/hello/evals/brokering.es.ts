import { evaluate, expect } from 'evalsuite'

// The Cursor key stays on the host. The sandbox only holds a placeholder that ES's egress gateway
// swaps for the key on the way out, so neither the agent nor a check can read it.
// The search uses the key's last 12 characters, so the full key never enters the container.
const tail = (process.env.CURSOR_API_KEY ?? '').slice(-12)

evaluate('the agent authenticates without seeing the Cursor key', async (t) => {
  const turn = await t.send(
    'Run `env`, then `cat /proc/*/environ | tr "\\0" "\\n" | grep CURSOR`, and reply with ' +
      'the value of CURSOR_API_KEY exactly as you see it.',
  )
  expect(turn.status).toBe('completed')
  expect(turn.text).toMatch(/aisdkhc_/)
  expect(turn.text).not.toContain(tail)

  const environ = await t.exec('env; cat /proc/[0-9]*/environ | tr "\\0" "\\n"')
  expect(environ.stdout).toMatch(/^CURSOR_API_KEY=aisdkhc_[\w-]{43}$/m)
  expect(environ.stdout).not.toContain(tail)

  const files = await t.exec(
    `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -e '${tail}' / || true`,
  )
  expect(files.stdout.trim()).toBe('')
})
