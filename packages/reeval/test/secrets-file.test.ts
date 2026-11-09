// REEVAL_SECRETS_FILE: read once and deleted, each secret's mode deciding who gets its value. The
// fixtures under test/features/secrets/file-* check what the agent and the eval code see.
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fakeConfig, project, readRun, runCli } from './helpers.ts'

const evalFile = (env: string, body = '') => `
import { evaluate, expect, defineEnvironment } from 'reeval'
const keys = defineEnvironment('keys', ({ secret }) => ({ env: ${env} }))
evaluate('reads', { environments: keys }, async () => {
  ${body}
})
`

async function withFile(env: string, secrets: unknown, body?: string, hostEnv = {}) {
  const p = await project('secrets-file', {
    'reeval.config.ts': fakeConfig({ harness: "{ script: [[{ exec: 'true' }]] }" }),
    'evals/reads.eval.ts': evalFile(env, body),
  })
  const file = join(p.dir, 'secrets.json')
  writeFileSync(file, typeof secrets === 'string' ? secrets : JSON.stringify(secrets))
  const r = await runCli(p.dir, ['run'], { env: { ...hostEnv, REEVAL_SECRETS_FILE: file } })
  return { ...r, dir: p.dir, file }
}

describe('REEVAL_SECRETS_FILE', () => {
  test('a readable secret is the eval code’s, over the same variable in the environment', async () => {
    const r = await withFile(
      "{ API_KEY: secret.fromEnv('API_KEY') }",
      { version: 1, secrets: { API_KEY: { mode: 'readable', value: 'from-the-file-1234' } } },
      "expect(process.env.API_KEY).toBe('from-the-file-1234')",
      { API_KEY: 'from-the-environment' },
    )
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(existsSync(r.file), false, 'reeval deleted the file')
    // Twin: the run read the file, so it masks the value it found there.
    assert.doesNotMatch(r.stdout, /from-the-file-1234/)
  })

  test('a brokered secret on a sandbox with no gateway fails its attempt as an infra error', async () => {
    const r = await withFile("{ API_KEY: secret.fromEnv('API_KEY') }", {
      version: 1,
      secrets: { API_KEY: { mode: 'brokered', hosts: ['api.example.com'], value: 'v-123456789' } },
    })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      readRun(r.dir).evals[0]?.error?.message ?? '',
      /API_KEY for .* is brokered to api\.example\.com, and this sandbox has no egress gateway to swap it in/,
    )
  })

  test('a brokered secret sent to hosts it isn’t brokered to fails its attempt', async () => {
    const r = await withFile(
      "{ API_KEY: secret.fromEnv('API_KEY', { hosts: ['api.other.test'] }) }",
      {
        version: 1,
        secrets: {
          API_KEY: { mode: 'brokered', hosts: ['api.example.com'], value: 'v-123456789' },
        },
      },
    )
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(
      readRun(r.dir).evals[0]?.error?.message ?? '',
      /is brokered to api\.example\.com, and .* sends it to api\.other\.test, which it isn't brokered to/,
    )
  })

  test('a file that isn’t one is refused, and deleted all the same', async () => {
    for (const [content, why] of [
      ['{', "isn't JSON"],
      [
        JSON.stringify({ version: 2, secrets: {} }),
        'is version 2, and this reeval reads version 1',
      ],
      [
        JSON.stringify({ version: 1, secrets: { K: { mode: 'brokered', value: 'v' } } }),
        'has no hosts for K',
      ],
      [
        JSON.stringify({ version: 1, secrets: { K: { mode: 'open', value: 'v' } } }),
        'gives K the mode "open"',
      ],
    ] as const) {
      const r = await withFile('{}', content)
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.ok(r.stderr.includes(why), r.stderr)
      assert.equal(existsSync(r.file), false)
    }
  })
})
