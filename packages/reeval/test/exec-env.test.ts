// `c.exec`'s own `env`: a brokered secret's host value goes in as its placeholder without
// rewriting a word that holds a short one, and a secret-named value a runner sends is masked
// even when the attempt protocol refuses the call that carries it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execEnv } from '../src/attempt/checks.ts'
import type { Attempt } from '../src/attempt/state.ts'
import type { AttemptRequest } from '../src/contract/attempt.ts'
import { replyToAttempt } from '../src/language-runner/attempt-host.ts'
import { redactSecrets } from '../src/redact.ts'
import type { AttemptContext } from '../src/types.ts'

const brokering = (...secrets: Array<[value: string, placeholder: string]>) =>
  ({
    env: { substitutions: secrets.map(([value, placeholder]) => ({ value, placeholder })) },
  }) as unknown as Attempt

test('a long brokered value is replaced wherever it is', () => {
  const a = brokering(['k3y-0123456789', 'PH_LONG'])
  assert.deepEqual(execEnv(a, { AUTH: 'Bearer k3y-0123456789', RAW: 'xk3y-0123456789y' }), {
    AUTH: 'Bearer PH_LONG',
    RAW: 'xPH_LONGy',
  })
})

test('a short brokered value is replaced only as a token of its own', () => {
  const a = brokering(['test', 'PH_SHORT'], ['a.b+', 'PH_DOTS'])
  assert.deepEqual(
    execEnv(a, {
      AUTH: 'Bearer test',
      WHOLE: 'test',
      WORD: 'latest-version',
      SNAKE: 'run_test_suite',
      DOTS: 'x a.b+ y',
      NOT_DOTS: 'axb+',
    }),
    {
      AUTH: 'Bearer PH_SHORT',
      WHOLE: 'PH_SHORT',
      WORD: 'latest-version',
      SNAKE: 'run_test_suite',
      DOTS: 'x PH_DOTS y',
      NOT_DOTS: 'axb+',
    },
  )
})

test('a secret-named exec value the protocol refuses is masked from then on', async () => {
  const value = ['rr', 'refused', '3k9d', '7m2p'].join('-')
  const subject = ['ss', 'subject', '4j8f', '6n1q'].join('-')
  const ask = (call: Record<string, unknown>) =>
    replyToAttempt({} as AttemptContext, [], new Map(), { id: '1', call } as AttemptRequest)
  const exec = await ask({ op: 'exec', command: 'true', env: { API_TOKEN: `${value}\0` } })
  const poll = await ask({
    op: 'expect',
    subject: { exec: 'true', env: { MY_SECRET: `${subject}\0` } },
    matcher: 'toSucceed',
    args: [],
    not: false,
    soft: false,
  })
  for (const [reply, secret] of [
    [exec, value],
    [poll, subject],
  ] as const) {
    assert.equal(reply.ok, false)
    const text = JSON.stringify(reply)
    assert.ok(text.includes(secret), 'twin: the refusal quotes the value')
    assert.ok(!redactSecrets(text).includes(secret), text)
  }
})
