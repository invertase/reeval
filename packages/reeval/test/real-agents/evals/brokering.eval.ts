import { createHash } from 'node:crypto'
import { defineEnvironment, evaluate, expect } from 'reeval'

// The harness's key stays on the host. The sandbox only holds a placeholder that reeval's egress
// gateway swaps for the key on the way out, so neither the agent nor a check can read it. A
// completed turn proves the agent authenticated through the gateway; the checks below prove the
// key isn't in the sandbox, whatever the agent chooses to print.
// No part of a key is ever printed or sent into the container: the host compares whole keys, and
// the in-container search gets only hashes of each key (see scan/scan.mjs).
const keys = [
  process.env.CURSOR_API_KEY,
  process.env.ANTHROPIC_API_KEY,
  process.env.GEMINI_API_KEY,
  process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  process.env.OPENAI_API_KEY,
  process.env.XAI_API_KEY,
  process.env.AI_GATEWAY_API_KEY,
  process.env.VERCEL_OIDC_TOKEN,
].filter((key): key is string => Boolean(key))

/** The rolling hash scan.mjs uses: base 257, mod 2^32, over the bytes. */
const rollingHash = (bytes: Uint8Array) => {
  let h = 0
  for (const b of bytes) h = (Math.imul(h, 257) + b) >>> 0
  return h
}

/** What the scanner looks for: each key's raw and base64 bytes as a length and two hashes. */
const targets = JSON.stringify(
  keys.flatMap((key) =>
    [Buffer.from(key), Buffer.from(Buffer.from(key).toString('base64'))].map((bytes, i) => ({
      form: i === 0 ? 'raw' : 'base64',
      len: bytes.length,
      roll: rollingHash(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  ),
)

/** Whether `text` holds any key. A boolean, so a failure can't print the key. */
const holdsAKey = (text: string) => keys.some((key) => text.includes(key))

const scanned = defineEnvironment('scanned', ({ file }) => ({
  files: { '~/.reeval-scan/scan.mjs': file('../scan/scan.mjs') },
}))

evaluate(
  'the agent authenticates without seeing its API key',
  { tags: ['smoke'], environments: scanned },
  async (c) => {
    const turn = await c.send(
      'Run `env | sort > env.txt` and reply with how many lines env.txt has.',
    )
    expect(turn.status).toBe('completed')
    expect(holdsAKey(turn.text), 'the reply holds a key').toBe(false)

    // What the agent's own shell saw: a placeholder, or no key after a CLI that unsets it.
    // The agent's processes may have exited by now, so `environ` alone can't show it
    // for every harness.
    const seen = (await c.readFile('env.txt')) ?? ''
    const environ = await c.exec('env; cat /proc/[0-9]*/environ | tr "\\0" "\\n"')
    const dumped = `${seen}\n${environ.stdout}`
    const keyLines = dumped.split('\n').filter((line) => /^\w+_API_KEY=/.test(line))
    for (const line of keyLines) {
      expect(line).toMatch(/^\w+_API_KEY=(?:aisdkhc_[\w-]{43}|reeval_secret_[0-9A-Za-z]{32})?$/)
    }
    expect(holdsAKey(dumped), 'env or /proc holds a key').toBe(false)

    const scan = await c.exec(`node ~/.reeval-scan/scan.mjs '${targets}'`)
    expect(scan.exitCode).toBe(0)
    const found = JSON.parse(scan.stdout) as { files: number; hits: string[] }
    expect(found.files).toBeGreaterThan(0)
    expect(found.hits).toEqual([])
  },
)
