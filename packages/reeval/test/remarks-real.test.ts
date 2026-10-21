// The over-remarking canary, in real.yml's pinned contract leg: one well-written eval, one real
// attempt on Cursor, and google/gemini-3.8-flash writing the run's insights. Remarks are almost
// always none, so the model raises no remark here, kept or dropped by the gates. Checks the
// insights document only, never the model's wording, and never retries. Skipped unless
// REEVAL_TEST_REAL=1; asked for, a missing key fails, naming it.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunInsights } from '../src/view/insights.ts'
import { project, readRun, runCli } from './helpers.ts'
import { harnesses, reserveAttempts } from './support/harnesses.ts'

const MODEL = 'google/gemini-3.8-flash'

const skip =
  process.env.REEVAL_TEST_REAL === '1' ? false : 'set REEVAL_TEST_REAL=1 to run real agents'

test('a well-written eval on a real analysis model gets no remarks', {
  skip,
  timeout: 900_000,
}, async (t) => {
  const cursor = harnesses.find((r) => r.id === 'cursor')
  assert.ok(cursor)
  const google = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!google) {
    throw new Error(
      `GOOGLE_GENERATIVE_AI_API_KEY isn't set, and REEVAL_TEST_REAL=1 asks for ${MODEL}'s insights: set it`,
    )
  }
  reserveAttempts(cursor, 1, 'remarks')
  const p = await project('remarks-real', {
    'reeval.config.ts': `import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

export default defineConfig({
  harness: cursor({ model: 'composer-2.5', params: { fast: 'false' } }),
  runs: 1,
  timeout: '4m',
  budget: { attempts: 1 },
  judge: { model: '${MODEL}' },
  analysis: { model: '${MODEL}' },
})
`,
    'evals/hello.eval.ts': `import { evaluate, expect } from 'reeval'

evaluate('writes hello from reeval to hello.txt', async (c) => {
  await c.send(
    'Create a file named hello.txt whose only content is \`hello from reeval\`, then stop.',
  )
  expect((await c.readFile('hello.txt'))?.trim(), 'hello.txt says hello').toMatch(
    /^hello from reeval\\.?$/,
  )
  expect(
    await c.judge('Does the final message say that hello.txt was created?'),
  ).toPass()
})
`,
  })
  const r = await runCli(p.dir, ['run', '-v'], {
    env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY: google },
    timeoutMs: 840_000,
  })
  assert.ok(r.code === 0 || r.code === 1, `reeval run exited ${r.code}\n${r.stdout}\n${r.stderr}`)
  const file = join(readRun(p.dir).dir, 'insights.json')
  assert.ok(existsSync(file), `no insights were written\n${r.stdout}\n${r.stderr}`)
  const doc = JSON.parse(readFileSync(file, 'utf8')) as RunInsights
  assert.equal(doc.model, MODEL)
  assert.equal(doc.evals.length, 1, 'the eval has its insight')
  const dropped = (doc.validation.drops ?? []).filter((d) => / › remark /.test(d.slot))
  t.diagnostic(`${doc.usage.inputTokens} in, ${doc.usage.outputTokens} out`)
  for (const d of dropped) t.diagnostic(`dropped ${d.slot}: "${d.text}": ${d.reason}`)
  assert.deepEqual(
    doc.remarks.filter((x) => x.origin === 'model').map((x) => `${x.kind}: ${x.text}`),
    [],
    'no model remark is kept',
  )
  assert.deepEqual(
    dropped.map((d) => d.slot),
    [],
    'the model raised none for the gates to drop',
  )
  assert.doesNotMatch(r.stdout, /^Remarks:/m)
})
