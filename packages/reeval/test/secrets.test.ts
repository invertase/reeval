// Tier U for brokered secrets: what resolveEnvironment hands the sandbox and the gateway, which
// secrets the gateway swaps in when, the unbrokered warning's inventory, and encoded redaction.
// The network-level proof (the upstream gets the value, the container never has it) is in
// sandbox-docker's proxy and Docker tests.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, test } from 'node:test'
import { docker, type Substitution } from '@reeval/sandbox-docker'
import { assertionRecords } from '../src/attempt/assertions.ts'
import { recordFailure, stagedRecordJson, turnErrors } from '../src/attempt/record.ts'
import type { Attempt } from '../src/attempt/state.ts'
import { AttemptDebug, withDebug } from '../src/debug/attempt.ts'
import '../src/debug/docker.ts'
import type { RawAssertion } from '../src/engine/runtime.ts'
import { type BrokeredSecret, resolveEnvironment } from '../src/environment/resolve.ts'
import { applied, defineEnvironment, unbrokeredSecrets } from '../src/environment.ts'
import { cursorMcpServers } from '../src/harness/agents.ts'
import { capText, OUTPUT_CAP, rawLines, turnError, turnText } from '../src/history/assemble.ts'
import { findingLines, findingSummary, scanText } from '../src/history/secret-scan.ts'
import { transcriptForJudge } from '../src/judge/transcript.ts'
import type { PlannedAttempt } from '../src/options.ts'
import { brokeredIn, secretVarsIn, unbrokered, unbrokeredWarning } from '../src/options.ts'
import {
  countSecrets,
  findSecrets,
  findSecretsInJson,
  maskedMatch,
  redactJson,
  redactJsonText,
  redactKey,
  redactSecrets,
  redactSplitSecrets,
  redactValue,
  registerSecret,
  type SecretMatch,
} from '../src/redact.ts'
import { scrubber } from '../src/report/scrub.ts'
import { brokerPhases } from '../src/sandbox/phases.ts'
import { FAILURE_CAP } from '../src/text.ts'
import type { EnvironmentInput, EvalRecord, TranscriptEvent } from '../src/types.ts'
import { tempDir } from './helpers.ts'

const VALUE = 'reeval-unit-brokered-4f1c9e2a7b'
const OTHER = 'reeval-unit-other-9d3a61c0e5'
process.env.REEVAL_UNIT_BROKERED = VALUE
process.env.REEVAL_UNIT_OTHER = OTHER

const PLACEHOLDER = /^reeval_secret_[0-9A-Za-z]{32}$/

const resolve = (input: EnvironmentInput) =>
  resolveEnvironment(applied(defineEnvironment('e', input)), {}, '/p', 'e', 'AGENTS.md')

describe('resolving brokered secrets', () => {
  test('the sandbox gets a placeholder, and the gateway the value on its hosts', async () => {
    const r = await resolve(({ secret }) => ({
      env: { API_KEY: secret.fromEnv('REEVAL_UNIT_BROKERED', { hosts: secret.hosts.gemini }) },
    }))
    assert.match(r.vars.API_KEY ?? '', PLACEHOLDER)
    assert.deepEqual(r.substitutions, [
      {
        name: 'API_KEY',
        placeholder: r.vars.API_KEY,
        value: VALUE,
        hosts: ['generativelanguage.googleapis.com'],
        in: ['header'],
        phase: 'agent',
      },
    ])
  })

  test('a value with a line break in it fails the attempt when it would go in a header', async () => {
    process.env.REEVAL_UNIT_WRAPPED = 'AQ.abc\n   │ def'
    try {
      await assert.rejects(
        resolve(({ secret }) => ({
          env: { API_KEY: secret.fromEnv('REEVAL_UNIT_WRAPPED', { hosts: secret.hosts.gemini }) },
        })),
        /^InfraError: API_KEY has whitespace or a line break in it \(character 7\), so it can't go in a request header\. A key copied from a wrapped terminal line picks these up; set it again as one line\.$/,
      )
      // A body-only secret may be anything, a PEM say.
      const r = await resolve(({ secret }) => ({
        env: {
          API_KEY: secret.fromEnv('REEVAL_UNIT_WRAPPED', {
            hosts: ['api.example.com'],
            in: ['body'],
          }),
        },
      }))
      assert.match(r.vars.API_KEY ?? '', PLACEHOLDER)
    } finally {
      delete process.env.REEVAL_UNIT_WRAPPED
    }
  })

  test('the record names the brokered secret, and never has its value or placeholder', async () => {
    const r = await resolve(({ secret }) => ({
      env: { API_KEY: secret.fromEnv('REEVAL_UNIT_BROKERED', { hosts: ['api.example.com'] }) },
    }))
    assert.deepEqual(r.record.brokered, ['API_KEY'])
    assert.deepEqual(r.record.secrets, ['API_KEY'])
    const record = JSON.stringify(r.record)
    assert.equal(record.includes(VALUE), false)
    assert.equal(record.includes(r.vars.API_KEY ?? '?'), false)
  })

  test('twin: the same search finds the secret name in the record', async () => {
    const r = await resolve(({ secret }) => ({
      env: { API_KEY: secret.fromEnv('REEVAL_UNIT_BROKERED', { hosts: ['api.example.com'] }) },
    }))
    assert.equal(JSON.stringify(r.record).includes('API_KEY'), true)
  })

  test('each attempt gets a fresh placeholder, and the digest stays the same', async () => {
    const input: EnvironmentInput = ({ secret }) => ({
      env: { API_KEY: secret.fromEnv('REEVAL_UNIT_BROKERED', { hosts: ['api.example.com'] }) },
    })
    const [a, b] = [await resolve(input), await resolve(input)]
    assert.notEqual(a.vars.API_KEY, b.vars.API_KEY)
    assert.equal(a.record.digest, b.record.digest)
  })

  test('the digest covers hosts and in', async () => {
    const digest = async (options: object) =>
      (
        await resolve(({ secret }) => ({
          env: { API_KEY: secret.fromEnv('REEVAL_UNIT_BROKERED', options) },
        }))
      ).record.digest
    const base = await digest({ hosts: ['api.example.com'] })
    assert.notEqual(await digest({}), base)
    assert.notEqual(await digest({ hosts: ['api.example.org'] }), base)
    assert.notEqual(await digest({ hosts: ['api.example.com'], in: ['header', 'body'] }), base)
  })

  test("a to: 'checks' secret gives the checks a placeholder, brokered in the checks phase", async () => {
    const r = await resolve(({ secret }) => ({
      env: {
        CHECK_KEY: secret.fromEnv('REEVAL_UNIT_BROKERED', {
          to: 'checks',
          hosts: ['api.example.com'],
        }),
      },
    }))
    assert.equal(r.vars.CHECK_KEY, undefined)
    assert.match(r.checkVars.CHECK_KEY ?? '', PLACEHOLDER)
    assert.equal(r.substitutions[0]?.phase, 'checks')
    assert.equal(r.substitutions[0]?.placeholder, r.checkVars.CHECK_KEY)
  })

  test('a secret without hosts is still the real value', async () => {
    const r = await resolve(({ secret }) => ({
      env: { API_KEY: secret.fromEnv('REEVAL_UNIT_OTHER') },
    }))
    assert.equal(r.vars.API_KEY, OTHER)
    assert.deepEqual(r.substitutions, [])
    assert.deepEqual(r.record.brokered, [])
  })

  test("MCP header secrets are brokered to the server's own host over HTTPS", async () => {
    const r = await resolve(({ secret, mcp }) => ({
      mcp: {
        docs: mcp.http('https://mcp.example.com/v1', {
          headers: {
            'x-api-key': secret.fromEnv('REEVAL_UNIT_BROKERED'),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
            authorization: secret.template('Bearer ${REEVAL_UNIT_OTHER}'),
          },
        }),
      },
    }))
    const server = r.mcp.docs
    assert.ok(server && server.transport === 'http')
    assert.match(server.headers['x-api-key'] ?? '', PLACEHOLDER)
    assert.match(server.headers.authorization ?? '', /^Bearer reeval_secret_[0-9A-Za-z]{32}$/)
    // What the Cursor adapter forwards to the agent: the placeholders, never the values.
    const forwarded = JSON.stringify(cursorMcpServers(r.mcp))
    assert.ok(forwarded.includes(server.headers['x-api-key'] ?? '?'))
    assert.equal(forwarded.includes(VALUE) || forwarded.includes(OTHER), false)
    assert.deepEqual(
      r.substitutions.map((s) => [s.name, s.value, s.hosts]),
      [
        ['x-api-key', VALUE, ['mcp.example.com']],
        ['REEVAL_UNIT_OTHER', OTHER, ['mcp.example.com']],
      ],
    )
  })

  test('MCP header secrets on plain HTTP stay real values', async () => {
    const r = await resolve(({ secret, mcp }) => ({
      mcp: {
        local: mcp.http('http://localhost:3333', {
          headers: { 'x-api-key': secret.fromEnv('REEVAL_UNIT_BROKERED') },
        }),
      },
    }))
    const server = r.mcp.local
    assert.ok(server && server.transport === 'http')
    assert.equal(server.headers['x-api-key'], VALUE)
    assert.deepEqual(r.substitutions, [])
  })

  test('MCP stdio env secrets are brokered only with explicit hosts', async () => {
    const r = await resolve(({ secret, mcp }) => ({
      mcp: {
        gh: mcp.stdio('gh-mcp', [], {
          env: {
            GITHUB_TOKEN: secret.fromEnv('REEVAL_UNIT_BROKERED', { hosts: secret.hosts.github }),
            OTHER_TOKEN: secret.fromEnv('REEVAL_UNIT_OTHER'),
          },
        }),
      },
    }))
    const server = r.mcp.gh
    assert.ok(server && server.transport === 'stdio')
    assert.match(server.env.GITHUB_TOKEN ?? '', PLACEHOLDER)
    assert.equal(server.env.OTHER_TOKEN, OTHER)
    assert.deepEqual(r.record.brokered, ['GITHUB_TOKEN'])
  })
})

describe('broker phases', () => {
  const sub = (name: string, phase: BrokeredSecret['phase']): BrokeredSecret => ({
    name,
    placeholder: `reeval_secret_${name}`,
    value: `value-${name}`,
    hosts: ['api.example.com'],
    in: ['header'],
    phase,
  })
  const recorder = () => {
    const calls: string[][] = []
    return {
      calls,
      last: () => calls.at(-1),
      async setSubstitutions(subs: readonly Substitution[]) {
        assert.equal(
          subs.some((s) => 'phase' in s),
          false,
          'the gateway gets substitutions only',
        )
        calls.push(subs.map((s) => s.name))
      },
    }
  }

  test("the agent's secrets are active from the start, the checks' only during a check", async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('AGENT', 'agent'), sub('CHECK', 'checks')])
    await phases.start()
    assert.deepEqual(box.last(), ['AGENT'])
    const during = await phases.checks(async () => box.last())
    assert.deepEqual(during, ['AGENT', 'CHECK'])
    assert.deepEqual(box.last(), ['AGENT'])
  })

  test('twin: during a check, the checks secret is active', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('CHECK', 'checks')])
    await phases.start()
    assert.deepEqual(await phases.checks(async () => box.last()), ['CHECK'])
  })

  test('overlapping checks keep the checks phase until the last one ends', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('CHECK', 'checks')])
    await phases.start()
    let release = () => {}
    const slow = phases.checks(() => new Promise<void>((r) => (release = r)))
    await phases.checks(async () => {})
    assert.deepEqual(box.last(), ['CHECK'], 'the slow check is still running')
    release()
    await slow
    assert.deepEqual(box.last(), [])
  })

  test('a failing check still ends the checks phase', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('CHECK', 'checks')])
    await phases.start()
    await assert.rejects(
      phases.checks(async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.deepEqual(box.last(), [])
  })

  test('with no checks secrets, checks change nothing', async () => {
    const box = recorder()
    const phases = brokerPhases(box, [sub('AGENT', 'agent')])
    await phases.start()
    await phases.checks(async () => {})
    assert.deepEqual(box.calls, [['AGENT']])
  })

  test('a sandbox without a gateway runs checks as they are', async () => {
    const phases = brokerPhases({}, [sub('CHECK', 'checks')])
    await phases.start()
    assert.equal(await phases.checks(async () => 'ran'), 'ran')
  })
})

describe('unbrokered secrets', () => {
  test('lists env and MCP secrets the sandbox would get as real values', () => {
    const env = defineEnvironment('e', ({ secret, mcp }) => ({
      env: {
        PLAIN: secret.fromEnv('HOST_PLAIN'),
        BROKERED: secret.fromEnv('HOST_BROKERED', { hosts: ['api.example.com'] }),
      },
      mcp: {
        stdio: mcp.stdio('x', [], { env: { STDIO_KEY: secret() } }),
        remote: mcp.http('https://mcp.example.com', { headers: { auth: secret() } }),
        local: mcp.http('http://localhost:1', {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
          headers: { auth: secret.template('Bearer ${LOCAL_TOKEN}') },
        }),
      },
    }))
    assert.deepEqual(unbrokeredSecrets({ OPT: { kind: 'secret' } }, env.layers), [
      { label: 'OPT', from: 'OPT' },
      { label: 'PLAIN', from: 'HOST_PLAIN' },
      { label: 'mcp.stdio.env.STDIO_KEY', from: 'STDIO_KEY' },
      { label: 'mcp.local.headers.auth', from: 'LOCAL_TOKEN' },
    ])
  })

  test('a later layer that brokers a variable leaves nothing unbrokered', () => {
    const parent = defineEnvironment('parent', ({ secret }) => ({ env: { KEY: secret() } }))
    const child = parent.extendEnvironment('child', ({ secret }) => ({
      env: { KEY: secret({ hosts: ['api.example.com'] }) },
    }))
    assert.deepEqual(unbrokeredSecrets({}, child.layers), [])
  })

  test('twin: a later layer that drops hosts is unbrokered', () => {
    const parent = defineEnvironment('parent', ({ secret }) => ({
      env: { KEY: secret({ hosts: ['api.example.com'] }) },
    }))
    const child = parent.extendEnvironment('child', ({ secret }) => ({ env: { KEY: secret() } }))
    assert.deepEqual(unbrokeredSecrets({}, child.layers), [{ label: 'KEY', from: 'KEY' }])
  })

  test("a to: 'checks' secret's warning says what keeps it from the agent and what doesn't", () => {
    assert.equal(
      unbrokeredWarning({ label: 'CHECK_TOKEN', from: 'CHECK_TOKEN', checksOnly: true }),
      "CHECK_TOKEN reaches the checks (c.exec, setup steps) as its real value. It's never in the agent's own environment, but a process a setup step leaves running holds it while the agent works. To give the checks only a placeholder, add the hosts it's sent to, e.g. secret.fromEnv('CHECK_TOKEN', { hosts: ['api.example.com'] }).",
    )
    const env = { CHECK_TOKEN: { kind: 'secret' as const, to: 'checks' as const } }
    const [found] = unbrokeredSecrets(env, [])
    assert.deepEqual(found, { label: 'CHECK_TOKEN', from: 'CHECK_TOKEN', checksOnly: true })
    assert.match(
      unbrokeredWarning({ label: 'PLAIN', from: 'PLAIN' }),
      /^PLAIN is in the sandbox as its real value/,
    )
  })

  test("every variable of a header's secret.template is a secret the run masks", () => {
    const env = defineEnvironment('e', ({ secret, mcp }) => ({
      mcp: {
        local: mcp.http('http://localhost:1', {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
          headers: { auth: secret.template('Basic ${ACME_USER}:${ACME_PASS}') },
        }),
      },
    }))
    const attempt = { environment: applied(env) } as PlannedAttempt
    assert.deepEqual(secretVarsIn({}, attempt), ['ACME_USER', 'ACME_PASS'])
    const https = defineEnvironment('e', ({ secret, mcp }) => ({
      mcp: {
        remote: mcp.http('https://mcp.example.com', {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: secret.template's syntax
          headers: { auth: secret.template('Basic ${ACME_USER}:${ACME_PASS}') },
        }),
      },
    }))
    const on = (kind: 'fake' | 'docker') =>
      ({ sandbox: { kind }, environment: applied(https) }) as PlannedAttempt
    assert.deepEqual(brokeredIn({}, on('docker')), ['mcp.remote.headers.auth → mcp.example.com'])
    assert.deepEqual(brokeredIn({}, on('fake')), [])
    assert.deepEqual(unbrokeredSecrets({}, env.layers), [
      { label: 'mcp.local.headers.auth', from: 'ACME_USER' },
      { label: 'mcp.local.headers.auth', from: 'ACME_PASS' },
    ])
  })

  test('only Docker attempts count', () => {
    const env = defineEnvironment('e', ({ secret }) => ({ env: { PLAIN: secret() } }))
    const attempt = (kind: 'fake' | 'docker') =>
      ({ sandbox: { kind }, environment: applied(env) }) as PlannedAttempt
    assert.deepEqual(unbrokered({}, [attempt('fake')]), [])
    assert.deepEqual(unbrokered({}, [attempt('docker'), attempt('docker')]), [
      { label: 'PLAIN', from: 'PLAIN' },
    ])
  })
})

describe('redacting encoded forms', () => {
  const value = 'reeval unit/leak+7c"1d&9a?0b'
  registerSecret(value)
  const cases: Array<[string, string]> = [
    ['raw', value],
    ['JSON-escaped', JSON.stringify(value).slice(1, -1)],
    ['JSON-escaped twice', JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1)],
    ['URL-encoded', encodeURIComponent(value)],
    ['form-encoded', new URLSearchParams({ v: value }).toString().slice(2)],
    ['base64', Buffer.from(value).toString('base64')],
    ['base64url', Buffer.from(value).toString('base64url')],
    ['base64 at offset 1', Buffer.from(`a${value}`).toString('base64')],
    ['base64 at offset 2', Buffer.from(`ab${value}`).toString('base64')],
    ['base64 in a Basic header', Buffer.from(`user:${value}`).toString('base64')],
  ]
  for (const [what, form] of cases) {
    test(`masks the ${what} form`, () => {
      const out = redactSecrets(`before ${form} after`, {})
      assert.match(out, /\[REDACTED\]/)
      assert.equal(out.includes(form), false)
    })
  }

  test('twin: a form the redactor does not know (hex) is left as is', () => {
    const hex = Buffer.from(value).toString('hex')
    assert.equal(redactSecrets(hex, {}), hex)
  })
})

test("masks every direct model provider's key by its value, whatever its shape", () => {
  const env = {
    ANTHROPIC_API_KEY: 'anthr0pic-test-value-4f9a',
    OPENAI_API_KEY: 'open4i-test-value-7c2e',
    GOOGLE_GENERATIVE_AI_API_KEY: 'g00gle-test-value-1b3d',
    TYPESAFE_AI_API_KEY: 'typ3safe-test-value-8e5f',
  }
  for (const [name, value] of Object.entries(env)) {
    assert.equal(redactSecrets(`${name}=${value}`, env), `${name}=[REDACTED]`)
  }
})

describe('redacting fragments of a secret', () => {
  const key = 'crsr_7f3Kq9ZpL2mXw8Rt4VbN6yHc1JdS'
  const env = { CURSOR_API_KEY: key }

  test('masks the last 12 characters of a key, as a leak check would print them', () => {
    const tail = key.slice(-12)
    const out = redactSecrets(`$ grep -rlsF -e '${tail}' / || true`, env)
    assert.equal(out, "$ grep -rlsF -e '[REDACTED]' / || true")
  })

  test('masks any stretch of 8 or more characters, wherever it starts', () => {
    for (const [start, end] of [
      [0, 8],
      [5, 19],
      [11, 30],
      [key.length - 8, key.length],
    ] as const) {
      const fragment = key.slice(start, end)
      const out = redactSecrets(`a ${fragment} b`, env)
      assert.equal(out, 'a [REDACTED] b', fragment)
    }
  })

  test('masks fragments inside JSON, a transcript line and a record', () => {
    const text = JSON.stringify({ stdout: `key=${key.slice(3, 20)}\n`, cmd: key.slice(-10) })
    const out = redactSecrets(text, env)
    assert.equal(out.includes(key.slice(3, 20)) || out.includes(key.slice(-10)), false, out)
    assert.equal(out, JSON.stringify({ stdout: 'key=[REDACTED]\n', cmd: '[REDACTED]' }))
  })

  test('masks fragments of a declared secret whatever its variable is called', () => {
    const declared = 'reeval-declared/9c4e+a1b7d20f'
    registerSecret(declared)
    assert.equal(redactSecrets(`x ${declared.slice(2, 14)} y`, {}), 'x [REDACTED] y')
  })

  test('twin: 7 characters, a path-valued variable and word-like windows are left as they are', () => {
    assert.equal(redactSecrets(key.slice(4, 11), env), key.slice(4, 11))
    const home = '/home/someone-12345/.ssh/id_ed25519'
    assert.equal(
      redactSecrets('/home/someone-12345/work', { SSH_KEY_PATH: home }),
      '/home/someone-12345/work',
    )
    const worded = 'password-2026-reset-token'
    const env2 = { RESET_TOKEN: worded }
    assert.equal(redactSecrets('forgot my password', env2), 'forgot my password')
    assert.equal(redactSecrets('ord-2026-res', env2), '[REDACTED]')
  })

  test("never breaks a record's JSON: a JSON-valued variable and quoted windows aren't masked alone", () => {
    const targets = JSON.stringify([{ form: 'raw', len: 36, sha256: 'ab12cd34ef56ab12' }])
    const record = JSON.stringify({ context: [{ path: 'AGENTS.md', sha256: 'ab12cd34ef56ab12' }] })
    const out = redactSecrets(record, { REEVAL_CONTRACT_KEY_TARGETS: targets })
    assert.deepEqual(JSON.parse(out), JSON.parse(record))
    registerSecret('q"uoted-se,cret:9f3a')
    const quoted = JSON.stringify({ a: 'uoted-se', b: 'd-se,cre', c: 'q"uoted-s' })
    assert.doesNotThrow(() => JSON.parse(redactSecrets(quoted, {})))
  })

  test('countSecrets counts a fragment, so a history or analysis write stops on it', () => {
    assert.equal(countSecrets(`tail ${key.slice(-12)}`, env), 1)
    assert.equal(countSecrets(`whole ${key} and tail ${key.slice(-12)}`, env), 2)
    assert.equal(countSecrets('nothing here', env), 0)
  })

  test('findSecrets says where each match is and why, and maskedMatch shows no known value', () => {
    const google = `AIza${'Q'.repeat(31)}WXYZ`
    const text = `a ${key} b ${google} c`
    const found = findSecrets(text, env)
    assert.deepEqual(
      found.map((m) => [text.slice(m.start, m.end), m.rule, m.known]),
      [
        [key, 'the value of CURSOR_API_KEY', true],
        [google, 'Google API key', false],
      ],
    )
    assert.equal(maskedMatch(text, found[0] as SecretMatch), 'the value of CURSOR_API_KEY')
    assert.equal(maskedMatch(text, found[1] as SecretMatch), 'Google API key (AIza…WXYZ)')
    const tail = findSecrets(`tail ${key.slice(-12)}`, env)
    assert.deepEqual(
      tail.map((m) => m.rule),
      ['the value of CURSOR_API_KEY'],
    )
  })

  test('scanText places a match inside a patch by file and new-side line', () => {
    const google = `AIza${'Q'.repeat(35)}`
    const patch = [
      'diff --git a/README.md b/README.md',
      'index 1111111..2222222 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/.env.example b/.env.example',
      'index 3333333..4444444 100644',
      '--- a/.env.example',
      '+++ b/.env.example',
      '@@ -4,4 +4,4 @@ comment',
      ' A=1',
      '-B=',
      '-GONE=1',
      '+B=2',
      `+GEMINI_API_KEY=${google}`,
      ' C=3',
      '',
    ].join('\n')
    const findings = scanText('worktree.patch', patch)
    assert.deepEqual(
      findings.map((f) => [f.file, f.line, f.rule]),
      [['.env.example', 6, 'Google API key']],
    )
    assert.deepEqual(findingLines('worktree.patch', findings), [
      'worktree.patch: .env.example line 6: Google API key (AIza…QQQQ)',
    ])
    assert.equal(findingSummary(findings), '.env.example line 6: Google API key')
    assert.deepEqual(
      scanText('notes.txt', `one\ntwo ${google}\n`).map((f) => [f.file, f.line]),
      [[null, 2]],
    )
    // A host git with core.quotePath on quotes a non-ASCII name; ` b/` can be inside a name.
    const awkward = [
      'diff --git a/README.md b/README.md',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '+new',
      'diff --git "a/caf\\303\\251.env" "b/caf\\303\\251.env"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/caf\\303\\251.env"',
      '@@ -0,0 +1 @@',
      `+KEY=${google}`,
      'diff --git a/x b/y.env b/x b/y.env',
      '--- a/x b/y.env',
      '+++ b/x b/y.env',
      '@@ -1 +1 @@',
      `+KEY=${google}`,
      '',
    ].join('\n')
    assert.deepEqual(
      scanText('worktree.patch', awkward).map((f) => [f.file, f.line]),
      [
        ['café.env', 1],
        ['x b/y.env', 1],
      ],
    )
    const many = scanText('notes.txt', Array.from({ length: 7 }, () => google).join('\n'))
    assert.equal(findingLines('notes.txt', many).at(-1), 'notes.txt: and 2 more')
    assert.equal(findingSummary(many).endsWith(', and 4 more'), true)
  })
})

describe('redacting a secret split across stream parts', () => {
  const key = 'sk-ant-api03-Zq8vR2mN4xL7pK1wT9yB3cF6hJ0'
  const env = { ANTHROPIC_API_KEY: key }
  const pin = 'Tr0ub4dor&3'
  registerSecret(pin)
  const reply = `Your key is ${key} and the PIN is ${pin}.`
  const chunks = (text: string) => text.match(/.{1,4}/g) as string[]
  /** The AI SDK parts of one streamed text block, one line each, as trace and raw lines hold them. */
  const textParts = (text: string, id = 't', type = 'text') => [
    JSON.stringify({ ms: 0, part: { type: `${type}-start`, id } }),
    ...chunks(text).map((d, i) =>
      JSON.stringify({ ms: i + 1, part: { type: `${type}-delta`, id, text: d } }),
    ),
    JSON.stringify({ ms: 99, part: { type: `${type}-end`, id } }),
  ]
  /** What a reader rebuilds from the lines: every string at `pick`, joined. */
  const rebuilt = (lines: string[], pick: (v: Record<string, never>) => unknown) =>
    lines
      .map((l) => pick(JSON.parse(l)))
      .filter((s) => typeof s === 'string')
      .join('')
  const written = (lines: string[]) =>
    redactJsonText(redactSplitSecrets(lines, env).join('\n'), env).split('\n')
  const deltaText = (lines: string[]) =>
    rebuilt(lines, (l) => (l as { part: { text?: string } }).part.text)

  test('canary: masked line by line, 4-character deltas still rebuild the key and the PIN', () => {
    const lines = redactJsonText(textParts(reply).join('\n'), env).split('\n')
    assert.equal(deltaText(lines), reply)
  })

  test('the deltas of a reply rebuild it with the key and the PIN masked once each', () => {
    const lines = written(textParts(reply))
    assert.equal(deltaText(lines), 'Your key is [REDACTED] and the PIN is [REDACTED].')
    assert.equal(lines.length, textParts(reply).length)
  })

  test("a harness's native chunks are masked too, between other parts and in another shape", () => {
    // ACP's agent_message_chunk, as a raw part beside the AI SDK delta it became.
    const lines = chunks(reply).flatMap((d, i) => [
      JSON.stringify({
        turn: 0,
        ms: i,
        part: {
          type: 'raw',
          rawValue: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: d } },
        },
      }),
      JSON.stringify({ turn: 0, ms: i, part: { type: 'text-delta', id: 'm', text: d } }),
      JSON.stringify({
        turn: 0,
        ms: i,
        part: { type: 'raw', rawValue: { sessionUpdate: 'usage_update', used: i } },
      }),
    ])
    const out = written(lines)
    const native = rebuilt(
      out,
      (l) =>
        (l as { part: { rawValue?: { content?: { text?: string } } } }).part.rawValue?.content
          ?.text,
    )
    assert.equal(native, 'Your key is [REDACTED] and the PIN is [REDACTED].')
    assert.equal(deltaText(out), 'Your key is [REDACTED] and the PIN is [REDACTED].')
  })

  test('interleaved reasoning and text deltas each join by their type', () => {
    const text = textParts(`The key: ${key}`, 'a', 'text')
    const reasoning = textParts(`Thinking about ${key} now`, 'b', 'reasoning')
    const lines = text
      .flatMap((l, i) => [l, reasoning[i] as string])
      .concat(reasoning.slice(text.length))
    const out = written(lines)
    assert.equal(out.join('\n').includes(key), false)
    for (const [type, want] of [
      ['text-delta', 'The key: [REDACTED]'],
      ['reasoning-delta', 'Thinking about [REDACTED] now'],
    ]) {
      const joined = rebuilt(out, (l) => {
        const p = (l as { part: { type: string; text?: string } }).part
        return p.type === type ? p.text : undefined
      })
      assert.equal(joined, want)
      assert.equal(joined.includes(key.slice(0, 8)), false)
    }
  })

  test('two interleaved text blocks each join by their id', () => {
    const a = textParts(`Block a has ${key} in it`, 'a')
    const b = textParts('Block b is about something else, and it runs on for a while longer', 'b')
    const lines = b.flatMap((l, i) => [...(a[i] ? [a[i] as string] : []), l])
    const out = written(lines)
    assert.equal(out.join('\n').includes(key.slice(0, 8)), false)
    const block = (id: string) =>
      rebuilt(out, (l) => {
        const p = (l as { part: { id: string; text?: string } }).part
        return p.id === id ? p.text : undefined
      })
    assert.equal(block('a'), 'Block a has [REDACTED] in it')
    assert.equal(block('b'), 'Block b is about something else, and it runs on for a while longer')
  })

  test('ACP message chunks join by their update, with thought chunks between them', () => {
    const acp = (sessionUpdate: string, text: string) =>
      JSON.stringify({
        part: { type: 'raw', rawValue: { sessionUpdate, content: { type: 'text', text } } },
      })
    const thoughts = chunks('I should answer the question about the key without delay')
    const lines = chunks(reply).flatMap((d, i) => [
      acp('agent_message_chunk', d),
      ...(thoughts[i] ? [acp('agent_thought_chunk', thoughts[i] as string)] : []),
    ])
    const out = written(lines)
    const message = rebuilt(out, (l) => {
      const v = (l as { part: { rawValue: { sessionUpdate: string; content: { text: string } } } })
        .part.rawValue
      return v.sessionUpdate === 'agent_message_chunk' ? v.content.text : undefined
    })
    assert.equal(message, 'Your key is [REDACTED] and the PIN is [REDACTED].')
  })

  test('twin: lines with no split secret, and a line that is not JSON, stay byte for byte', () => {
    const lines = [
      ...textParts('nothing to see here, only a long enough reply'),
      '{"a": 1,  "b": "spaced"}',
      'not json',
      JSON.stringify({ part: { type: 'text-delta', text: `whole ${key}` } }),
    ]
    assert.deepEqual(redactSplitSecrets(lines, env), lines)
  })

  test('trace.ndjson masks a secret streamed as deltas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reeval-split-trace-'))
    const before = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = key
    try {
      const debug = new AttemptDebug({ dir, verbosity: 0, traceLimit: 1024 * 1024 })
      for (const line of textParts(reply)) debug.trace('harness', 'stream', JSON.parse(line), false)
      await debug.finish(true)
      const trace = readFileSync(join(dir, 'trace.ndjson'), 'utf8').trim().split('\n').slice(1)
      const joined = rebuilt(
        trace,
        (l) => (l as { data: { part: { text?: string } } }).data.part.text,
      )
      assert.equal(joined, 'Your key is [REDACTED] and the PIN is [REDACTED].')
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = before
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('transcript.raw.jsonl masks a secret streamed as deltas', () => {
    const before = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = key
    try {
      const raw = textParts(reply).map((l) => JSON.parse(l))
      const text = rawLines({ turns: [{ raw }] } as unknown as EvalRecord) as string
      const lines = text.trim().split('\n')
      assert.equal(lines.length, raw.length)
      assert.equal(JSON.parse(lines[0] as string).turn, 0)
      assert.equal(deltaText(lines), 'Your key is [REDACTED] and the PIN is [REDACTED].')
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = before
    }
  })

  test('the staging record masks it, so transcript.raw.jsonl built from it has no pieces left', () => {
    const before = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = key
    try {
      // Deltas of 8 or more characters are masked one by one; the short ones between them aren't.
      const sizes = [16, 4, 12, 4, 12, 4, 40]
      let at = 0
      const raw = sizes.map((n) => {
        const text = reply.slice(at, at + n)
        at += n
        return { type: 'text-delta', id: 't', text }
      })
      const staged = JSON.parse(stagedRecordJson({ turns: [{ raw }] } as unknown as EvalRecord))
      const want = 'Your key is [REDACTED] and the PIN is [REDACTED].'
      assert.equal(
        rebuilt(staged.turns[0].raw.map(JSON.stringify), (p) => (p as { text: string }).text),
        want,
      )
      const lines = (rawLines(staged) as string).trim().split('\n')
      assert.equal(
        rebuilt(lines, (l) => (l as { text: string }).text),
        want,
      )
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = before
    }
  })
})

// Last in the file: the short secrets these register would otherwise reach every test above.
describe('redacting serialised JSON', () => {
  const record = {
    error: null,
    ok: true,
    durationMs: 51234,
    tokens: { input: 1234, output: 12340 },
    text: 'PIN 1234, set to null',
    turns: [{ status: 'completed', exitCode: null }],
  }

  test('a declared secret of "null" and a short number mask strings, never JSON values', () => {
    registerSecret('null')
    registerSecret('1234')
    const out = redactJson(record, 2, {})
    assert.deepEqual(JSON.parse(out), {
      ...record,
      text: 'PIN [REDACTED], set to [REDACTED]',
    })
    assert.equal(
      redactJsonText(`${JSON.stringify(record, null, 2)}\n`, {}),
      `${JSON.stringify({ ...record, text: 'PIN [REDACTED], set to [REDACTED]' }, null, 2)}\n`,
    )
    // Twin: redacting the serialised text breaks it.
    assert.throws(() => JSON.parse(redactSecrets(JSON.stringify(record), {})))
  })

  test('redactValue masks a value the way its record is masked once written', () => {
    const state = {
      output: 1234,
      checks: [{ command: 'printf %s "$CHECK_TOKEN"', exitCode: 0, stdout: VALUE, stderr: '' }],
      contents: { 'missing.txt': null, '.env': `TOKEN=${VALUE}\n` },
    }
    const masked = redactValue(state, { CHECK_TOKEN: VALUE })
    assert.deepEqual(masked, {
      output: 1234,
      checks: [{ ...state.checks[0], stdout: '[REDACTED]' }],
      contents: { 'missing.txt': null, '.env': 'TOKEN=[REDACTED]\n' },
    })
    assert.equal(
      redactJson(masked, 2, { CHECK_TOKEN: VALUE }),
      redactJson(state, 2, { CHECK_TOKEN: VALUE }),
    )
  })

  test('JSON Lines keep every byte outside the strings they mask, and a broken line is masked as text', () => {
    registerSecret('null')
    registerSecret('1234')
    const lines = [
      '{"n":12345678901234567890,"at":1.50,"pin":"1234"}',
      '',
      'not json: 1234 null',
      '{ "spaced" : null }',
      '',
    ].join('\n')
    assert.equal(
      redactJsonText(lines, {}),
      [
        '{"n":12345678901234567890,"at":1.50,"pin":"[REDACTED]"}',
        '',
        'not json: [REDACTED] [REDACTED]',
        '{ "spaced" : null }',
        '',
      ].join('\n'),
    )
  })

  test('a private key across lines that are not JSON is masked whole, and a byte-order mark is kept', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----'
    assert.equal(redactJsonText(`{"a":1}\n${pem}\n{"b":2}`, {}), '{"a":1}\n[REDACTED]\n{"b":2}')
    registerSecret('null')
    assert.equal(
      redactJsonText('\uFEFF{"e":null,"s":"null"}', {}),
      '\uFEFF{"e":null,"s":"[REDACTED]"}',
    )
  })

  test('keys: a short declared secret never renames a field, but is masked in a data key', () => {
    registerSecret('error')
    registerSecret('pin7')
    const key = 'reeval-unit-key-as-a-key-8b2f'
    registerSecret(key)
    const out = JSON.parse(
      redactJson({ error: 'an error', [key]: 1, 'file-pin7.txt': 2, pin7: 3 }, undefined, {}),
    )
    assert.deepEqual(out, {
      error: 'an [REDACTED]',
      '[REDACTED]': 1,
      'file-[REDACTED].txt': 2,
      pin7: 3,
    })
    assert.equal(redactKey('error', {}), 'error')
  })

  test('a secret with characters JSON escapes is masked inside its string', () => {
    const quoted = 'reeval "quoted"\\secret\n9d1f'
    registerSecret(quoted)
    const out = redactJson(
      { stdout: `got ${quoted} back`, nested: [JSON.stringify(quoted)] },
      2,
      {},
    )
    assert.deepEqual(JSON.parse(out), { stdout: 'got [REDACTED] back', nested: ['"[REDACTED]"'] })
  })

  test('the history scan and the analysis check flag only what redaction masks', () => {
    registerSecret('null')
    registerSecret('1234')
    const json = `${JSON.stringify(record, null, 2)}\n`
    assert.deepEqual(findSecretsInJson(JSON.stringify({ error: null, n: 51234 }), {}), [])
    assert.deepEqual(
      scanText('run.json', json).map((f) => [f.line, f.rule]),
      [
        [9, 'a declared secret'],
        [9, 'a declared secret'],
      ],
    )
    assert.deepEqual(
      scanText('t.jsonl', '{"x":null}\n{"y":"null"}\n').map((f) => f.line),
      [2],
    )
    // The scan flags a key exactly when redaction masks it.
    registerSecret('abcdef"')
    assert.equal(redactJsonText('{"abcdef\\"":1}', {}), '{"[REDACTED]":1}')
    assert.equal(findSecretsInJson('{"abcdef\\"":1}', {}).length, 1)
    registerSecret('field')
    assert.equal(redactJsonText('{"field":"field"}', {}), '{"field":"[REDACTED]"}')
    assert.equal(findSecretsInJson('{"field":"field"}', {}).length, 1)
    // Twin: the same text outside a JSON file counts the literals too.
    assert.equal(scanText('run.txt', json).length > 2, true)
  })

  test("a report's scrubber keeps JSON Lines valid", () => {
    registerSecret('null')
    const scrub = scrubber({ env: {}, home: '/home/someone', project: '/home/someone/p' })
    const line = '{"error":null,"cwd":"/home/someone/p/x","said":"null"}'
    assert.equal(scrub.json(line), '{"error":null,"cwd":"<project>/x","said":"[REDACTED]"}')
    assert.deepEqual(scrub.value({ error: 'null' }), { error: '[REDACTED]' })
  })
})

describe('masking before shortening', () => {
  // Secret-named but not token-like, so only the whole value is masked, never its fragments.
  const secret = 'correct-horse-battery-staple'
  const withSecret = (fn: () => Promise<void> | void) => async () => {
    process.env.REEVAL_TEST_CUT_PASSWORD = secret
    try {
      await fn()
    } finally {
      delete process.env.REEVAL_TEST_CUT_PASSWORD
    }
  }

  test(
    "a failure's message is masked before its middle is cut",
    withSecret(() => {
      const head = Math.floor(FAILURE_CAP * 0.75)
      const message = `${'x'.repeat(head - 14)} password=${secret} ${'y'.repeat(FAILURE_CAP)}`
      const a = {
        record: { error: null, judgements: [], outcome: 'pass' },
        signal: new AbortController().signal,
        judgeThrown: new Set(),
      } as unknown as Attempt
      recordFailure(a, new Error(message), false, [])
      assert.match(a.record.error?.message ?? '', /characters cut/)
      assert.match(a.record.error?.message ?? '', /password=\[RED/)
      assert.doesNotMatch(a.record.error?.message ?? '', /password=corr/)
    }),
  )

  test(
    "a turn's error is masked before it's clipped",
    withSecret(() => {
      const message = `${'x'.repeat(480)}=${secret}`
      const [line] = turnErrors([[{ type: 'error', message } as TranscriptEvent]])
      assert.match(line ?? '', /=\[REDACTED\]/)
      assert.doesNotMatch(line ?? '', /=corr/)
    }),
  )

  test(
    "an assertion's label and message are masked before they're clipped",
    withSecret(() => {
      const [x] = assertionRecords([
        {
          matcher: 'toBe',
          args: [`${'x'.repeat(40)}=${secret}`],
          status: 'fail',
          soft: false,
          error: new Error(`${'x'.repeat(1017)}=${secret}`),
        } as unknown as RawAssertion,
      ])
      assert.match(`${x?.label} ${x?.message}`, /=\[RED.*=\[RED/)
      assert.doesNotMatch(`${x?.label} ${x?.message}`, /=corr/)
    }),
  )

  test(
    'an oversized trace entry is masked before its head is kept',
    withSecret(async () => {
      const dir = tempDir('trace-head')
      const debug = new AttemptDebug({ dir, verbosity: 0, traceLimit: 1024 * 1024 })
      // The entry's head is the first 64 KB of `{"text":"…"}`: the secret starts 4 characters before it ends.
      const text = `${'x'.repeat(64 * 1024 - 23)} password=${secret} ${'y'.repeat(300 * 1024)}`
      debug.trace('harness', 'big', { text }, false)
      await debug.finish(true)
      const trace = readFileSync(join(dir, 'trace.ndjson'), 'utf8')
      assert.match(trace, /"clipped":/)
      assert.match(trace, /password=\[RED/)
      assert.doesNotMatch(trace, /password=corr/)
    }),
  )

  test(
    "a docker command's output is masked before the attempt's trace clips it",
    withSecret(async () => {
      // A `docker` on the PATH whose stdout puts the secret across the trace's 4096-character clip.
      const bin = tempDir('trace-docker')
      writeFileSync(
        join(bin, 'docker.js'),
        `process.stdout.write('x'.repeat(4096 - 14) + ' password=' + process.env.REEVAL_TEST_CUT_PASSWORD + ' ' + 'y'.repeat(5000))\n`,
      )
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexec node "$(dirname "$0")/docker.js" "$@"\n')
      chmodSync(join(bin, 'docker'), 0o755)
      writeFileSync(join(bin, 'docker.cmd'), '@node "%~dp0docker.js" %*\r\n')
      const dir = tempDir('trace-docker-debug')
      const shown: string[] = []
      const debug = new AttemptDebug({
        dir,
        verbosity: 2,
        traceLimit: 1024 * 1024,
        emit: (line) => shown.push(line.detail ?? ''),
      })
      const path = process.env.PATH
      process.env.PATH = `${bin}${delimiter}${path}`
      try {
        await withDebug(debug, () => docker(['exec', 'c1', 'cat', '--', '/f']))
      } finally {
        process.env.PATH = path
      }
      await debug.finish(true)
      const trace = readFileSync(join(dir, 'trace.ndjson'), 'utf8')
      for (const text of [trace, shown.join('\n')]) {
        assert.match(text, /more\)/)
        assert.match(text, /password=\[RED/)
        assert.doesNotMatch(text, /password=corr/)
      }
    }),
  )

  test(
    "the judge's transcript cuts a tool's output before a secret, not through it",
    withSecret(() => {
      // No whitespace, so `clip` cuts at its limit: the secret starts 4 characters before it.
      const output = JSON.stringify({ rows: 'x'.repeat(267), dsn: `password=${secret}` })
      const event = { type: 'tool', tool: 'shell', input: { command: 'psql' }, output, ok: true }
      const shown = transcriptForJudge([event as TranscriptEvent], true).join('\n')
      assert.match(shown, /"password=…$/)
      assert.doesNotMatch(redactJson({ shown }), /password=corr/)
      const plain = { ...event, output: 'y'.repeat(400) }
      assert.match(transcriptForJudge([plain as TranscriptEvent], true)[0] ?? '', /y{299}…$/)
    }),
  )

  test(
    "a turn's final message and error are masked before the record cuts them",
    withSecret(() => {
      const text = turnText(`${'x'.repeat(8 * 1024 - 14)} password=${secret} ${'y'.repeat(100)}`)
      assert.match(text, /reeval: truncated/)
      assert.match(text, /password=\[RED/)
      assert.doesNotMatch(text, /password=corr/)
      const message = `${'x'.repeat(1024 - 14)} password=${secret}`
      const error = turnError([{ type: 'error', message } as TranscriptEvent]) ?? ''
      assert.match(error, /password=\[RED/)
      assert.doesNotMatch(error, /password=corr/)
    }),
  )

  test(
    'a large output is masked before its head and tail are kept',
    withSecret(() => {
      const head = 96 * 1024
      const tail = 16 * 1024
      const big = `${'x'.repeat(head - 14)} password=${secret} ${'y'.repeat(OUTPUT_CAP)}${secret}.${'z'.repeat(tail - 8)}`
      const capped = capText(big)
      assert.match(capped, /reeval: truncated/)
      assert.match(capped, /password=\[RED/)
      assert.doesNotMatch(capped, /password=corr|staple\.z/)
    }),
  )
})
