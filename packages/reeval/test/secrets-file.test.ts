// REEVAL_SECRETS_FILE: read once and deleted, each secret's mode deciding who gets its value. The
// fixtures under test/features/secrets/file-* check what the agent and the eval code see.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { placeholder } from '@reeval/sandbox-docker'
import { generateText } from 'ai'
import { hostModel } from '../src/analysis/model.ts'
import { resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment } from '../src/environment.ts'
import { vercelLanguageModel } from '../src/gateway/vercel-models.ts'
import { agentAuth, agentFor } from '../src/harness/agents.ts'
import { hostCall, judgeRoute } from '../src/judge/index.ts'
import { redactSecrets, registerSecret } from '../src/redact.ts'
import { gatewayGlue } from '../src/sandbox/docker.ts'
import { hostEnv, readSecretsFile } from '../src/secrets-file.ts'
import { pinStartEnv } from '../src/startup.ts'
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
        JSON.stringify({ version: 1, secrets: { K: { mode: 'brokered', hosts: [], value: 'v' } } }),
        'has no hosts for K, which is brokered: list them, or leave hosts out',
      ],
      [
        JSON.stringify({
          version: 1,
          secrets: { K: { mode: 'relayed', via: 'http://relay.example.com', value: 'v' } },
        }),
        'has no https:// via for K, which is relayed',
      ],
      [
        JSON.stringify({
          version: 1,
          secrets: { K: { mode: 'relayed', via: 'http://127.0.0.1:8787/v', value: 'v' } },
        }),
        'has no https:// via for K, which is relayed',
      ],
      ...[
        'https://u:p@relay.example.com/v',
        'https://relay.example.com/v?x=1',
        'https://relay.example.com/v#f',
      ].map((via) => [
        JSON.stringify({ version: 1, secrets: { K: { mode: 'relayed', via, value: 'v' } } }),
        'gives K a via with a user, a query or a fragment, where reeval takes an https:// origin and path only',
      ]),
      [
        JSON.stringify({ version: 1, secrets: { K: { mode: 'open', value: 'v' } } }),
        'gives K the mode "open", not brokered, relayed, sandbox or readable',
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

  test("reeval's own calls get the value: the agent's key on its endpoints, and the judge refuses a sandbox one", () => {
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
      /GOOGLE_GENERATIVE_AI_API_KEY for judge model "google\/gemini-3\.8-flash" is a sandbox secret, which only the agent's sandbox gets, and the judge model calls generativelanguage\.googleapis\.com .*give GOOGLE_GENERATIVE_AI_API_KEY the brokered mode with generativelanguage\.googleapis\.com among its hosts, or the readable mode/,
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

  test("reeval's own model calls use a brokered key on its hosts, and refuse it elsewhere", async () => {
    hold({
      ANTHROPIC_API_KEY: {
        mode: 'brokered',
        hosts: ['api.anthropic.com'],
        value: 'sk-ant-12345678',
      },
      OPENROUTER_API_KEY: { mode: 'brokered', hosts: ['openrouter.ai'], value: 'sk-or-123456789' },
      AI_GATEWAY_API_KEY: {
        mode: 'brokered',
        hosts: ['ai-gateway.vercel.sh'],
        value: 'vck-1234567890ab',
      },
      OPENAI_API_KEY: { mode: 'brokered', hosts: ['*.openai.com'], value: 'sk-oa-1234567890' },
    })
    const anthropic = hostCall('anthropic/claude-sonnet-5-5')
    assert.equal(anthropic.route.kind, 'direct')
    // The route alone, as `judgeRoute` gives it to anything kept, holds no key.
    assert.deepEqual(judgeRoute('anthropic/claude-sonnet-5-5'), {
      kind: 'direct',
      provider: 'anthropic',
      pkg: '@ai-sdk/anthropic',
    })
    assert.equal(anthropic.call.baseURL, 'https://api.anthropic.com/v1')
    assert.equal(anthropic.call.apiKey, 'sk-ant-12345678')
    assert.ok(anthropic.call.fetch)
    await assert.rejects(
      anthropic.call.fetch('https://elsewhere.example.com/v1/messages', { method: 'POST' }),
      /reeval refused to send ANTHROPIC_API_KEY, a brokered key, to https:\/\/elsewhere\.example\.com/,
    )
    const openai = hostCall('openai/gpt-6', process.env, 'analysis model')
    assert.ok(openai.route.kind === 'direct' && openai.call.apiKey === 'sk-oa-1234567890')
    const router = hostCall('google/gemini-3.8-flash', process.env, 'judge model', 'openrouter')
    assert.ok(router.route.kind === 'openrouter' && router.call.apiKey === 'sk-or-123456789')
    const gateway = hostCall('google/gemini-3.8-flash', process.env, 'judge model', 'vercel')
    assert.ok(gateway.route.kind === 'gateway' && gateway.call.apiKey === 'vck-1234567890ab')
    // The AI SDK's gateway provider gets the held value; without one, `ai` resolves the model by
    // name with the environment's key.
    assert.notEqual(typeof vercelLanguageModel('google/gemini-3.8-flash', gateway.call), 'string')
    assert.equal(typeof vercelLanguageModel('google/gemini-3.8-flash'), 'string')

    // Twins: the call goes to a host the key isn't brokered to, or over plain http.
    for (const [url, refusal] of [
      [
        'https://proxy.example.com/v1',
        /ANTHROPIC_API_KEY for judge model "anthropic\/claude-sonnet-5-5" is brokered to api\.anthropic\.com, and the judge model calls proxy\.example\.com, which it isn't brokered to/,
      ],
      [
        'http://api.anthropic.com/v1',
        /ANTHROPIC_API_KEY for judge model "anthropic\/claude-sonnet-5-5" is brokered, and the judge model would call http:\/\/api\.anthropic\.com\/v1: a brokered key goes only to an https:\/\/ URL, or to this machine/,
      ],
    ] as const) {
      process.env.ANTHROPIC_BASE_URL = url
      try {
        assert.throws(() => judgeRoute('anthropic/claude-sonnet-5-5'), refusal)
      } finally {
        delete process.env.ANTHROPIC_BASE_URL
      }
    }
    hold({
      AI_GATEWAY_API_KEY: {
        mode: 'brokered',
        hosts: ['api.example.com'],
        value: 'vck-1234567890ab',
      },
    })
    assert.throws(
      () => judgeRoute('google/gemini-3.8-flash', process.env, 'analysis model', 'vercel'),
      /AI_GATEWAY_API_KEY for analysis model "google\/gemini-3\.8-flash" is brokered to api\.example\.com, and the analysis model calls ai-gateway\.vercel\.sh, which it isn't brokered to/,
    )
  })

  test("a brokered judge key reaches the provider's endpoint, and the eval code's environment keeps the placeholder", async () => {
    let seen: string | undefined
    const server = createServer((req, res) => {
      seen = req.headers['x-api-key'] as string
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'no' } }),
      )
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    hold({
      ANTHROPIC_API_KEY: { mode: 'brokered', hosts: ['127.0.0.1'], value: 'sk-ant-wire-1234' },
    })
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/v1`
    // Eval code that wraps the global fetch never sees the call.
    const global = globalThis.fetch
    let wrapped = 0
    globalThis.fetch = (...args) => {
      wrapped++
      return global(...args)
    }
    try {
      const model = await hostModel('anthropic/claude-sonnet-5-5', 'direct', 'analysis model')
      await assert.rejects(generateText({ model, prompt: 'hi', maxRetries: 0 }))
      assert.equal(seen, 'sk-ant-wire-1234')
      assert.equal(wrapped, 0)
      assert.match(process.env.ANTHROPIC_API_KEY ?? '', /^reeval_secret_/)
    } finally {
      globalThis.fetch = global
      delete process.env.ANTHROPIC_BASE_URL
      server.close()
    }
  })

  test('a base URL changed after start, or a redirect, never takes a brokered key elsewhere', async () => {
    const seen: Record<string, string | undefined> = {}
    const listen = async (
      name: string,
      answer: (port: number) => [number, Record<string, string>],
    ) => {
      const server = createServer((req, res) => {
        seen[name] = req.headers['x-api-key'] as string
        const [status, headers] = answer((server.address() as AddressInfo).port)
        res.writeHead(status, headers)
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'no' } }),
        )
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      return server
    }
    const other = await listen('other', () => [401, { 'content-type': 'application/json' }])
    const otherPort = (other.address() as AddressInfo).port
    const pinnedServer = await listen('pinned', () => [401, { 'content-type': 'application/json' }])
    const redirecting = await listen('redirecting', () => [
      307,
      { location: `http://localhost:${otherPort}/v1/messages` },
    ])
    hold({
      ANTHROPIC_API_KEY: { mode: 'brokered', hosts: ['127.0.0.1'], value: 'sk-ant-pin-12345' },
    })
    try {
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(pinnedServer.address() as AddressInfo).port}/v1`
      pinStartEnv()
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${otherPort}/v1`
      const model = await hostModel('anthropic/claude-sonnet-5-5', 'direct', 'analysis model')
      await assert.rejects(generateText({ model, prompt: 'hi', maxRetries: 0 }))
      assert.equal(seen.pinned, 'sk-ant-pin-12345')
      assert.equal(seen.other, undefined)

      pinStartEnv(null)
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/v1`
      const redirected = await hostModel('anthropic/claude-sonnet-5-5', 'direct', 'analysis model')
      await assert.rejects(
        generateText({ model: redirected, prompt: 'hi', maxRetries: 0 }),
        /redirect/,
      )
      assert.equal(seen.redirecting, 'sk-ant-pin-12345')
      assert.equal(seen.other, undefined)
    } finally {
      pinStartEnv(null)
      delete process.env.ANTHROPIC_BASE_URL
      for (const server of [other, pinnedServer, redirecting]) server.close()
    }
  })

  test('a brokered key with no hosts goes where each use goes: the agent’s endpoints, the model’s base URL, and nowhere a config names none', async () => {
    hold({
      ANTHROPIC_API_KEY: { mode: 'brokered', value: 'sk-ant-hostless-1234' },
      OPENAI_API_KEY: { mode: 'brokered', value: 'sk-oa-hostless-12345' },
    })
    const claude = agentFor({
      kind: 'claude-code',
      model: 'claude-sonnet-5-5',
    } as AgentHarnessDescriptor)
    assert.deepEqual(agentAuth(claude), { ANTHROPIC_API_KEY: 'sk-ant-hostless-1234' })
    const route = hostCall('anthropic/claude-sonnet-5-5')
    assert.ok(route.route.kind === 'direct' && route.call.apiKey === 'sk-ant-hostless-1234')
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com/v1'
    try {
      const proxied = hostCall('anthropic/claude-sonnet-5-5')
      assert.ok(proxied.route.kind === 'direct' && proxied.call.fetch)
      assert.equal(proxied.call.baseURL, 'https://proxy.example.com/v1')
      // Its fetch takes the key to the base URL's host only.
      await assert.rejects(
        proxied.call.fetch('https://elsewhere.example.com/v1/messages', { method: 'POST' }),
        /reeval refused to send ANTHROPIC_API_KEY, a brokered key, to https:\/\/elsewhere\.example\.com/,
      )
    } finally {
      delete process.env.ANTHROPIC_BASE_URL
    }
    const kept = await resolve(({ secret }) => ({
      env: { K: secret.fromEnv('OPENAI_API_KEY', { hosts: ['api.example.com'] }) },
    }))
    assert.deepEqual(kept.substitutions[0]?.hosts, ['api.example.com'])
    // Twin: an environment that names no hosts has nowhere to send it.
    await assert.rejects(
      resolve(({ secret }) => ({ env: { K: secret.fromEnv('OPENAI_API_KEY') } })),
      /OPENAI_API_KEY .*is brokered with no hosts of its own, so .* has to name where it goes: secret\.fromEnv\('OPENAI_API_KEY', \{ hosts: \['api\.example\.com'\] \}\)/,
    )
  })

  test("a harness's endpoints come from the environment at start, so a later change can't move a key with no hosts", () => {
    hold({ AI_GATEWAY_API_KEY: { mode: 'brokered', value: 'vck-hostless-12345' } })
    const hostsOf = (agent: ReturnType<typeof agentFor>) => [
      ...new Set(agent.endpoints.map((e) => e.host)),
    ]
    const claude = { kind: 'claude-code', model: 'm', gateway: 'vercel' } as AgentHarnessDescriptor
    const bedrock = { kind: 'opencode', model: 'amazon-bedrock/m' } as AgentHarnessDescriptor
    process.env.AWS_REGION = 'eu-west-1'
    pinStartEnv()
    try {
      process.env.AI_GATEWAY_BASE_URL = 'https://attacker.example'
      process.env.AWS_REGION = 'ap-south-1'
      const agent = agentFor(claude)
      assert.deepEqual(hostsOf(agent), ['ai-gateway.vercel.sh'])
      assert.deepEqual(agentAuth(agent), { AI_GATEWAY_API_KEY: 'vck-hostless-12345' })
      assert.ok(hostsOf(agentFor(bedrock)).every((h) => h.includes('.eu-west-1.')))
      // Twin: the same values set before start are the project's own, and are followed.
      pinStartEnv()
      assert.deepEqual(hostsOf(agentFor(claude)), ['attacker.example'])
      assert.ok(hostsOf(agentFor(bedrock)).every((h) => h.includes('.ap-south-1.')))
    } finally {
      pinStartEnv(null)
      delete process.env.AI_GATEWAY_BASE_URL
      delete process.env.AWS_REGION
    }
  })

  test("a relayed key's calls go to its relay under the API's own path, and the agent's go there through the gateway", async () => {
    const via = 'https://relay.example.com/relay/'
    hold({
      ANTHROPIC_API_KEY: { mode: 'relayed', via, value: 'run-token-anthropic' },
      OPENROUTER_API_KEY: { mode: 'relayed', via, value: 'run-token-router-12' },
      AI_GATEWAY_API_KEY: {
        mode: 'relayed',
        via: 'https://relay.example.com/v',
        value: 'run-token-vercel-12',
      },
    })
    {
      const anthropic = hostCall('anthropic/claude-sonnet-5-5')
      assert.ok(anthropic.route.kind === 'direct')
      assert.equal(anthropic.call.baseURL, `${via.slice(0, -1)}/v1`)
      assert.equal(anthropic.call.apiKey, 'run-token-anthropic')
      const router = hostCall('google/gemini-3.8-flash', process.env, 'judge model', 'openrouter')
      assert.ok(router.route.kind === 'openrouter')
      assert.equal(router.call.baseURL, `${via.slice(0, -1)}/api/v1`)
      const gateway = hostCall('google/gemini-3.8-flash', process.env, 'judge model', 'vercel')
      assert.ok(gateway.route.kind === 'gateway' && gateway.call.apiKey === 'run-token-vercel-12')
      assert.equal(gateway.call.baseURL, 'https://relay.example.com/v/v4/ai')
      await assert.rejects(
        gateway.call.fetch?.('https://ai-gateway.vercel.sh/v4/ai/language-model') ??
          Promise.resolve(),
        /reeval refused to send AI_GATEWAY_API_KEY, a brokered key, to https:\/\/ai-gateway\.vercel\.sh/,
      )

      await assert.rejects(
        anthropic.call.fetch?.('https://api.anthropic.com/v1/messages') ?? Promise.resolve(),
        /reeval refused to send ANTHROPIC_API_KEY, a brokered key, to https:\/\/api\.anthropic\.com/,
      )

      // The agent's credential: its endpoints' requests go to the relay.
      const glue = gatewayGlue({
        egress: { policy: 'deny-all', auto: [] },
        brokering: {
          credential: 'AI_GATEWAY_API_KEY',
          endpoints: [
            { host: 'ai-gateway.vercel.sh', path: { exact: '/v1/messages' }, method: ['POST'] },
            { host: 'ai-gateway.vercel.sh', path: { exact: '/v1/models' }, method: ['GET'] },
          ],
        },
      } as never)
      assert.deepEqual((glue.egress as { relays?: unknown }).relays, [
        { hosts: ['ai-gateway.vercel.sh'], via: 'https://relay.example.com/v' },
      ])
      // Twin: a brokered credential has no relay.
      hold({ AI_GATEWAY_API_KEY: { mode: 'brokered', value: 'vck-hostless-12345' } })
      const plain = gatewayGlue({
        egress: { policy: 'deny-all', auto: [] },
        brokering: { credential: 'AI_GATEWAY_API_KEY', endpoints: [] },
      } as never)
      assert.equal((plain.egress as { relays?: unknown }).relays, undefined)

      // An environment's own secret can't take a relayed key.
      hold({ OPENROUTER_API_KEY: { mode: 'relayed', via, value: 'run-token-router-12' } })
      await assert.rejects(
        resolve(({ secret }) => ({
          env: { K: secret.fromEnv('OPENROUTER_API_KEY', { hosts: ['openrouter.ai'] }) },
        })),
        /OPENROUTER_API_KEY for .* is relayed, which only a harness's own credential and reeval's own model calls take/,
      )
    }
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
