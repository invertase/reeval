// Antigravity in Docker, in its own file so its attempts don't share docker.test.ts's time budget.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { imageFor, LABEL } from '@reeval/sandbox-docker'
import { project, readRun, runCli } from './helpers.ts'
import { harnesses, keyOf } from './support/harnesses.ts'

const liveContainers = (runId: string) =>
  execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL.run}=${runId}`], {
    encoding: 'utf8',
  }).trim()

// REEVAL_TEST_REQUIRE_DOCKER=1 (CI's docker job) fails instead of skipping.
const requireDocker = process.env.REEVAL_TEST_REQUIRE_DOCKER === '1'
const agyImageBuilt = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', imageFor('antigravity')], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const agyImage = {
  skip: !agyImageBuilt && !requireDocker && `needs Docker and ${imageFor('antigravity')}`,
  timeout: 300_000,
}
// The real-agent run needs a real Gemini API key, read as the contract's Antigravity row reads it
// (GEMINI_API_KEY, then GOOGLE_GENERATIVE_AI_API_KEY): without one it skips, even when Docker is
// required, unless REEVAL_TEST_REAL=1 asks for real agents, when it fails naming both.
const agyRow = harnesses.find((row) => row.id === 'antigravity')
assert.ok(agyRow?.key, 'the contract has an Antigravity row with a key')
const agyKeyNames = agyRow.key.from.join(' or ')
const realKey = keyOf(agyRow) ?? ''
const realAgy = {
  skip:
    !realKey && process.env.REEVAL_TEST_REAL !== '1'
      ? `needs ${agyKeyNames} (a Gemini API key) for a real Antigravity run`
      : agyImage.skip,
  timeout: 600_000,
}

describe('antigravity in docker', () => {
  test(
    'Antigravity attempts broker the key on its model endpoint only; without brokering the attempt fails closed',
    agyImage,
    async () => {
      const agyConfig = (sandbox: string) => `
import { defineConfig } from 'reeval'
import { antigravity } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({
  harness: antigravity({ model: 'gemini-3.8-flash-low' }),
  sandbox: ${sandbox},
  timeout: '90s',
})
`
      const eval_ = `import { evaluate, expect } from 'reeval'
evaluate('hi', async (t) => {
  const turn = await t.send('Reply with the word hi.')
  // Gemini saw the swapped-in (made-up) key: the gateway brokered it.
  expect(turn.transcript.some((e) => e.type === 'error' && /API_KEY_INVALID/.test(e.message ?? ''))).toBe(true)
  expect(turn.transcript.filter((e) => e.type === 'error')).toHaveLength(1)
  // Nothing in the sandbox holds the key: the CLI's own env had only the placeholder.
  const search = (needle: string) => t.exec(\`grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev \${needle} / || true\`)
  expect((await search('not_a_real_key')).stdout.trim()).toBe('')
  // Twin: the same search finds the settings the adapter wrote.
  expect((await search('modelProvider')).stdout).toContain('/.gemini/antigravity-cli/settings.json')
})
`
      // A made-up key, and host Google keys the adapter must ignore: the sandbox, the gateway and
      // the CLI start, the gateway swaps the key in, and the Gemini API refuses it (400).
      const env = {
        GEMINI_API_KEY: 'AIzaSy-not_a_real_key_0000000000000000',
        GOOGLE_API_KEY: 'host-google-not-used',
        GOOGLE_GEMINI_BASE_URL: 'https://proxy.invalid',
        REEVAL_DEBUG: '1',
      }
      const brokered = await project('docker-agy-brokered', {
        'reeval.config.ts': agyConfig('docker()'),
        'evals/d.eval.ts': eval_,
      })
      const started = Date.now()
      const a = await runCli(brokered.dir, ['run', '--ui', 'plain'], { env, timeoutMs: 240_000 })
      const out = a.stdout + a.stderr
      assert.equal(a.code, 0, out)
      assert.ok(Date.now() - started < 200_000, 'a refused key ends the turn; nothing hangs')
      assert.match(out, /turn 1 error: The API rejected GEMINI_API_KEY: set a valid key/)
      assert.match(
        out,
        /reeval:egress POST https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[\w.-]+:streamGenerateContent(\?alt=sse)? HTTP\/[\d.]+ \(set x-goog-api-key\)/,
      )
      // The twin of the checks below: the same search finds the gateway's lines.
      assert.match(out, /reeval:egress /)
      assert.doesNotMatch(out, /refused/, 'the key goes only to its endpoint')
      // CLI 1.2.11 still fetches feature flags (antigravity-unleash.goog) and logs to
      // play.googleapis.com, even with enableTelemetry off; both are tunnelled, never given the key.
      assert.doesNotMatch(
        out,
        /proxy\.invalid|cloudcode-pa|oauth2|accounts\.google|auto-updater/,
        'no host base URL, Google sign-in or auto-update',
      )
      const run = readRun(brokered.dir)
      assert.equal(liveContainers(run.run.runId), '')

      try {
        execFileSync('docker', ['pull', '-q', 'busybox:1.37'], { stdio: 'ignore' })
      } catch (error) {
        if (requireDocker) throw error
        return
      }
      const refused = await project('docker-agy-no-broker', {
        'reeval.config.ts': agyConfig("docker({ image: 'busybox:1.37', root: true })"),
        'evals/d.eval.ts': eval_,
      })
      const b = await runCli(refused.dir, ['run'], { env })
      assert.equal(b.code, 3, b.stdout + b.stderr)
      const refusedRun = readRun(refused.dir)
      assert.equal(refusedRun.evals[0]?.error?.kind, 'infra')
      assert.match(
        refusedRun.evals[0]?.error?.message ?? '',
        /^Can't keep GEMINI_API_KEY out of the sandbox: credential brokering could not start/,
      )
      assert.equal(liveContainers(refusedRun.run.runId), '')
    },
  )

  test(
    'a real Antigravity run edits the workspace, reads its rules and home skill, and never sees the key',
    realAgy,
    async () => {
      const key = realKey
      assert.ok(
        key,
        `${agyKeyNames} isn't set, and REEVAL_TEST_REAL=1 asks for a real Antigravity run`,
      )
      const p = await project('docker-agy-real', {
        'reeval.config.ts': `
import { defineConfig } from 'reeval'
import { antigravity } from 'reeval/harness'
import { docker } from 'reeval/sandbox'
export default defineConfig({
  harness: antigravity({ model: 'gemini-3.8-flash-low' }),
  sandbox: docker(),
  timeout: '5m',
})
`,
        'skills/owl-facts/SKILL.md':
          '---\nname: owl-facts\ndescription: Facts about owls. Use when asked for the owl code.\n---\n\nThe owl code is OWL-5521.\n',
        'evals/d.eval.ts': `import { defineEnvironment, evaluate, expect } from 'reeval'
const house = defineEnvironment('house', ({ skill }) => ({
  rules: 'When asked for the house word, answer exactly: PERIWINKLE-42',
  files: { 'probe.sh': 'printf %s "$GEMINI_API_KEY" | cut -c1-8 > /tmp/probe.txt\\necho probed\\n' },
  skills: [skill.local('../skills/owl-facts')],
}))
evaluate('real', { environment: house }, async (t) => {
  const edit = await t.send('Create hello.js that prints "hi from agy" with console.log, then run it with node and tell me what it printed.')
  expect(edit.status).toBe('completed')
  await expect(edit).toHaveFile('hello.js', /hi from agy/)
  expect((await t.exec('node hello.js')).stdout).toContain('hi from agy')
  expect(edit.transcript.some((e) => e.type === 'tool' && e.tool === 'bash')).toBe(true)
  expect(edit.transcript.some((e) => e.type === 'file-edit' && /hello\\.js$/.test(e.path))).toBe(true)
  const ask = await t.send('Reply on one line with the house word and the owl code.')
  expect(ask.text).toContain('PERIWINKLE-42')
  expect(ask.text).toContain('OWL-5521')
  // As the agent: a script it runs sees only the placeholder in the CLI's environment.
  const probe = await t.send('Run the shell command: sh probe.sh')
  expect(probe.transcript.some((e) => e.type === 'tool' && e.tool === 'bash')).toBe(true)
  expect((await t.exec('cat /tmp/probe.txt')).stdout.trim()).toBe('aisdkhc_')
})
`,
      })
      const r = await runCli(p.dir, ['run', '--ui', 'plain'], {
        env: { GEMINI_API_KEY: key },
        timeoutMs: 540_000,
      })
      const out = r.stdout + r.stderr
      assert.equal(r.code, 0, out.replaceAll(key, '<key>'))
      assert.doesNotMatch(out, /refused/, 'no request needed the key off its endpoint')
      const { run, dir } = readRun(p.dir)
      assert.equal(liveContainers(run.runId), '')
      // The CLI's token counts reach the record, per turn and totalled, and never go negative.
      const turns = run.evals[0]?.attempts[0]?.turns ?? []
      for (const t of turns) {
        assert.ok(t.usage && t.usage.input > 0 && t.usage.output > 0, JSON.stringify(t.usage))
        assert.ok(t.usage.cacheRead >= 0, JSON.stringify(t.usage))
        assert.equal(t.model, 'gemini-3.8-flash-low')
      }
      assert.equal(run.cost.source, 'reported')
      // The key (or its tail) is nowhere in what the run wrote, and the check can fail.
      const grep = (needle: string) => {
        try {
          return execFileSync('grep', ['-rlsF', needle, dir, `${dir}.json`], {
            encoding: 'utf8',
          }).trim()
        } catch {
          return ''
        }
      }
      assert.equal(grep(key.slice(-12)), '', 'the key is nowhere in the run')
      assert.notEqual(grep('PERIWINKLE-42'), '', 'twin: the search finds the answer')
    },
  )
})
