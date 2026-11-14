// REEVAL_SECRETS_FILE: read once and deleted, each secret's mode deciding who gets its value. The
// fixtures under test/features/secrets/file-* check what the agent and the eval code see.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { placeholder } from '@reeval/sandbox-docker'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment } from '../src/environment.ts'
import { agentAuth, agentFor } from '../src/harness/agents.ts'
import { judgeRoute } from '../src/judge/index.ts'
import { redactSecrets, registerSecret } from '../src/redact.ts'
import { hostEnv, readSecretsFile } from '../src/secrets-file.ts'
import type { AgentHarnessDescriptor, EnvironmentInput } from '../src/types.ts'
import { fakeConfig, project, readRun, runCli, tempDir } from './helpers.ts'

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

  test("a held CURSOR_API_KEY's value, not its placeholder, reads Cursor's model catalog at plan time", async () => {
    const key = `cursor-held-key-${Date.now()}`
    const cache = tempDir('secrets-file-cache')
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
    mkdirSync(join(cache, 'reeval'))
    writeFileSync(
      join(cache, `reeval/cursor-models-${hash}.json`),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        items: [{ id: 'composer-2.5', parameters: [] }],
      }),
    )
    const p = await project('secrets-file-cursor', {
      'reeval.config.ts': `import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'
export default defineConfig({ harnesses: cursor({ model: 'composer-2.5' }) })
`,
      'evals/a.eval.ts': "import { evaluate } from 'reeval'\nevaluate('a', async () => {})\n",
    })
    const file = join(p.dir, 'secrets.json')
    writeFileSync(
      file,
      JSON.stringify({ version: 1, secrets: { CURSOR_API_KEY: { mode: 'sandbox', value: key } } }),
    )
    const r = await runCli(p.dir, ['run', '--dry-run'], {
      env: { REEVAL_SECRETS_FILE: file, XDG_CACHE_HOME: cache },
    })
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(
      r.stdout,
      /effort: cursor:composer-2\.5 none \(Cursor's model catalog lists no effort for composer-2\.5\)/,
    )
    assert.doesNotMatch(r.stdout, /not checked against Cursor's model catalog/)
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
      [
        JSON.stringify({
          version: 1,
          secrets: { K: { mode: 'brokered', hosts: ['https://api.example.com'], value: 'v' } },
        }),
        'gives K the host "https://api.example.com", which isn\'t a host name',
      ],
    ] as const) {
      const r = await withFile('{}', content)
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.ok(r.stderr.includes(why), r.stderr)
      assert.equal(existsSync(r.file), false)
    }
  })
})

/** Reads `secrets` as the file this process was started with. */
function hold(secrets: Record<string, unknown>) {
  const file = join(tempDir('secrets-file-unit'), 'secrets.json')
  writeFileSync(file, JSON.stringify({ version: 1, secrets }))
  process.env.REEVAL_SECRETS_FILE = file
  readSecretsFile()
  assert.equal(existsSync(file), false)
}

const resolve = (input: EnvironmentInput) =>
  resolveEnvironment(applied(defineEnvironment('e', input)), {}, '/p', 'e', 'AGENTS.md')

describe('held secrets in this process', () => {
  test("a brokered one goes to the hosts the file and the config share, a sandbox one ignores the config's", async () => {
    hold({
      WILD_KEY: { mode: 'brokered', hosts: ['*.Example.com'], value: 'wild-value-123456' },
      BOX_KEY: { mode: 'sandbox', value: 'box-value-1234567' },
    })
    for (const [hosts, kept] of [
      [undefined, ['*.example.com']],
      [['api.example.com'], ['api.example.com']],
      [['*.a.example.com'], ['*.a.example.com']],
    ] as const) {
      const r = await resolve(({ secret }) => ({
        env: { K: secret.fromEnv('WILD_KEY', hosts ? { hosts: [...hosts] } : {}) },
      }))
      assert.deepEqual(r.substitutions[0]?.hosts, kept, String(hosts))
      assert.equal(r.substitutions[0]?.value, 'wild-value-123456')
    }
    await assert.rejects(
      resolve(({ secret }) => ({
        env: { K: secret.fromEnv('WILD_KEY', { hosts: ['example.com'] }) },
      })),
      /is brokered to \*\.example\.com, and .* sends it to example\.com, which it isn't brokered to/,
    )
    const box = await resolve(({ secret }) => ({
      env: { B: secret.fromEnv('BOX_KEY', { hosts: ['api.example.com'] }) },
    }))
    assert.equal(box.vars.B, 'box-value-1234567')
    assert.deepEqual(box.substitutions, [])
  })

  test("reeval's own calls get the value: the agent's key on its endpoints, and the judge refuses one", () => {
    hold({
      ANTHROPIC_API_KEY: {
        mode: 'brokered',
        hosts: ['api.anthropic.com'],
        value: 'sk-ant-held-123456',
      },
    })
    assert.match(process.env.ANTHROPIC_API_KEY ?? '', /^reeval_secret_/)
    assert.equal(hostEnv().ANTHROPIC_API_KEY, 'sk-ant-held-123456')
    const claude = agentFor({
      kind: 'claude-code',
      model: 'claude-sonnet-5-5',
    } as AgentHarnessDescriptor)
    assert.deepEqual(agentAuth(claude), { ANTHROPIC_API_KEY: 'sk-ant-held-123456' })
    hold({ GOOGLE_GENERATIVE_AI_API_KEY: { mode: 'sandbox', value: 'g-held-1234567890' } })
    assert.throws(
      () => judgeRoute('google/gemini-3.8-flash'),
      /GOOGLE_GENERATIVE_AI_API_KEY for judge model "google\/gemini-3\.8-flash" is a sandbox secret.*give GOOGLE_GENERATIVE_AI_API_KEY the readable mode/,
    )
    // Twin: brokered to hosts the agent doesn't call, the key isn't handed over.
    hold({
      ANTHROPIC_API_KEY: { mode: 'brokered', hosts: ['other.test'], value: 'sk-ant-held-123456' },
    })
    assert.throws(
      () => agentAuth(claude),
      /ANTHROPIC_API_KEY is brokered to other\.test, and the .* harness sends it to api\.anthropic\.com, which it isn't brokered to/,
    )
  })

  test('a placeholder is never masked, even registered as a secret, and one with no held value fails', async () => {
    const holder = placeholder()
    registerSecret(holder)
    assert.equal(redactSecrets(`sent ${holder}`, {}), `sent ${holder}`)
    process.env.LOST_KEY = holder
    await assert.rejects(
      resolve(({ secret }) => ({ env: { K: secret.fromEnv('LOST_KEY') } })),
      /LOST_KEY for .* is held from REEVAL_SECRETS_FILE, and this attempt couldn't get its value/,
    )
  })
})
