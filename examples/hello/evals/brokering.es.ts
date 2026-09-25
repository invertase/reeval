import { evaluate, expect } from 'evalsuite'

// The harness's key stays on the host. The sandbox only holds a placeholder that ES's egress
// gateway swaps for the key on the way out, so neither the agent nor a check can read it. A
// completed turn proves the agent authenticated through the gateway; the checks below prove the
// key isn't in the sandbox, whatever the agent chooses to print.
// The search uses each key's last 12 characters, so no full key ever enters the container.
const tails = [process.env.CURSOR_API_KEY, process.env.ANTHROPIC_API_KEY]
  .filter((key): key is string => Boolean(key))
  .map((key) => key.slice(-12))

evaluate('the agent authenticates without seeing its API key', { tags: ['smoke'] }, async (t) => {
  const turn = await t.send('Run `env | sort` and reply with how many variables it printed.')
  expect(turn.status).toBe('completed')
  for (const tail of tails) expect(turn.text).not.toContain(tail)

  const environ = await t.exec('env; cat /proc/[0-9]*/environ | tr "\\0" "\\n"')
  expect(environ.stdout).toMatch(/^(CURSOR|ANTHROPIC)_API_KEY=aisdkhc_[\w-]{43}$/m)
  for (const tail of tails) expect(environ.stdout).not.toContain(tail)

  const patterns = tails.map((tail) => `-e '${tail}'`).join(' ')
  const files = await t.exec(
    `grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev ${patterns} / || true`,
  )
  expect(files.stdout.trim()).toBe('')
})
