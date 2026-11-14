// `reeval cloud secrets`, `reeval cloud provider` and `reeval cloud gateway` against a fake
// platform that keeps eval secrets and provider and gateway keys as the platform's routes do, and
// refuses as they do.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runCli, tempDir } from './helpers.ts'

const TOKEN = 'cli-session-token'
const ADMIN = { id: 'usr_1', email: 'ada@example.com' }
const VALUE = 'sk_live_canary_value_0123456789'
/** The providers the fake platform keeps keys for; reeval itself has no list. */
const SERVED = ['openai', 'typesafe-ai', 'openrouter']
/** The gateways the fake platform keeps keys for. */
const GATEWAYS = ['vercel', 'openrouter']

type Seen = { method: string; path: string; auth?: string; body: string }
type Secret = { name: string; mode: string; hosts: string[] | null; version: number }

async function platform(options: { admin?: boolean } = {}) {
  const seen: Seen[] = []
  const secrets = new Map<string, Secret & { value: string }>()
  const keys = new Map<
    string,
    { route: string; name: string; projectId: string | null; key: string; version: number }
  >()
  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message, retryable: false } })
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => resolve(body))
    })
  const shown = ({ value: _, ...s }: Secret & { value: string }) => ({
    ...s,
    createdAt: '2026-11-09T20:00:00.000Z',
    updatedAt: '2026-11-09T21:00:00.000Z',
    updatedBy: ADMIN,
  })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    const body = await read(req)
    seen.push({
      method: req.method ?? '',
      path: url.pathname + url.search,
      ...(req.headers.authorization && { auth: req.headers.authorization }),
      body,
    })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return fail(res, 401, 'unauthorized', 'Sign in first.')
    }
    const write = req.method === 'PUT' || req.method === 'DELETE'
    if (write && options.admin === false) {
      return fail(res, 403, 'forbidden', 'Only an admin of the project can change its secrets.')
    }
    if (req.method === 'GET' && url.pathname === '/api/orgs') {
      return json(res, 200, { orgs: [{ id: 'org_a', slug: 'acme', name: 'ACME', role: 'admin' }] })
    }
    if (req.method === 'GET' && url.pathname === '/api/orgs/org_a/projects') {
      return json(res, 200, {
        projects: [
          { id: 'proj_a', orgId: 'org_a', slug: 'app', name: 'App' },
          { id: 'proj_b', orgId: 'org_a', slug: 'beta', name: 'Beta' },
        ],
      })
    }
    const s = /^\/api\/orgs\/([^/]+)\/projects\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(url.pathname)
    if (s) {
      const [, org, project, name] = s
      if (org !== 'org_a' || project !== 'proj_a') return fail(res, 404, 'not_found', 'Not found.')
      if (req.method === 'GET' && !name) {
        return json(res, 200, { secrets: [...secrets.values()].map(shown) })
      }
      if (req.method === 'DELETE' && name) {
        if (!secrets.delete(name)) return fail(res, 404, 'not_found', 'No such secret.')
        return json(res, 204)
      }
      if (req.method === 'PUT' && name) {
        const sent = JSON.parse(body)
        const had = secrets.get(name)
        const mode = sent.mode ?? had?.mode ?? 'brokered'
        const hosts = sent.hosts ?? (sent.mode ? null : had?.hosts) ?? null
        if (mode === 'brokered' && !hosts?.length) {
          return fail(res, 400, 'invalid_request', 'A brokered secret needs hosts.')
        }
        const next = { name, mode, hosts, version: (had?.version ?? 0) + 1, value: sent.value }
        secrets.set(name, next)
        return json(res, had ? 200 : 201, { secret: shown(next) })
      }
    }
    const p = /^\/api\/orgs\/([^/]+)\/(providers|gateways)(?:\/([^/]+))?$/.exec(url.pathname)
    if (p) {
      const [, org, route, name] = p
      const noun = route === 'gateways' ? 'gateway' : 'provider'
      if (org !== 'org_a') return fail(res, 404, 'not_found', 'Not found.')
      if (req.method === 'GET' && !name) {
        return json(res, 200, {
          [route as string]: [...keys.values()]
            .filter((k) => k.route === route)
            .map(({ key, route: _, name: n, ...k }) => ({
              [noun]: n,
              ...k,
              last4: key.slice(-4),
              updatedBy: ADMIN,
            })),
        })
      }
      if (req.method === 'PUT' && name) {
        if (!(route === 'gateways' ? GATEWAYS : SERVED).includes(name)) {
          return fail(res, 400, 'invalid_request', `${name} isn't a ${noun} this org can use.`)
        }
        const sent = JSON.parse(body)
        const id = `${route}/${name}/${sent.projectId ?? ''}`
        const had = keys.get(id)
        const next = {
          route: route as string,
          name,
          projectId: sent.projectId ?? null,
          key: sent.key,
          version: (had?.version ?? 0) + 1,
        }
        keys.set(id, next)
        return json(res, had ? 200 : 201, {
          [noun]: {
            [noun]: name,
            projectId: next.projectId,
            last4: sent.key.slice(-4),
            version: next.version,
          },
        })
      }
      if (req.method === 'DELETE' && name) {
        const id = `${route}/${name}/${url.searchParams.get('projectId') ?? ''}`
        if (!keys.delete(id)) return fail(res, 404, 'not_found', 'No such key.')
        return json(res, 204)
      }
    }
    fail(res, 404, 'not_found', `no route ${url.pathname}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    secrets,
    keys,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A project linked to `org_a`/`proj_a`, signed in with `REEVAL_TOKEN`. */
function linked(base: string) {
  const dir = tempDir('cloud-secrets')
  mkdirSync(join(dir, '.reeval'), { recursive: true })
  writeFileSync(
    join(dir, '.reeval/project.json'),
    JSON.stringify({ orgId: 'org_a', projectId: 'proj_a' }),
  )
  const env = {
    REEVAL_CLOUD_URL: base,
    REEVAL_TOKEN: TOKEN,
    XDG_CONFIG_HOME: tempDir('cloud-secrets-config'),
    REEVAL_NO_KEYCHAIN: '1',
  } as NodeJS.ProcessEnv
  return { dir, env }
}

const never = (text: string) =>
  assert.ok(!text.includes(VALUE), `the value is never printed: ${text}`)

describe('reeval cloud secrets', () => {
  test('sets a brokered secret from stdin, replaces its value keeping its mode, lists and deletes it', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const set = await runCli(
        dir,
        [
          'cloud',
          'secrets',
          'set',
          'STRIPE_KEY',
          '--host',
          'API.stripe.com',
          '--host',
          '*.stripe.net',
        ],
        { env, input: `${VALUE}\n` },
      )
      assert.equal(set.code, 0, set.stdout + set.stderr)
      assert.match(
        set.stdout,
        /Added STRIPE_KEY in proj_a: brokered to api\.stripe\.com, \*\.stripe\.net, version 1\./,
      )
      const put = p.seen.find((s) => s.method === 'PUT')
      assert.equal(put?.path, '/api/orgs/org_a/projects/proj_a/secrets/STRIPE_KEY')
      assert.equal(put?.auth, `Bearer ${TOKEN}`)
      assert.deepEqual(JSON.parse(put?.body ?? ''), {
        value: VALUE,
        mode: 'brokered',
        hosts: ['api.stripe.com', '*.stripe.net'],
      })

      const again = await runCli(dir, ['cloud', 'secrets', 'set', 'STRIPE_KEY'], {
        env,
        input: 'rotated',
      })
      assert.equal(again.code, 0, again.stderr)
      assert.match(
        again.stdout,
        /Replaced STRIPE_KEY in proj_a: brokered to api\.stripe\.com, \*\.stripe\.net, version 2\./,
      )
      assert.deepEqual(JSON.parse(p.seen.filter((s) => s.method === 'PUT')[1]?.body ?? ''), {
        value: 'rotated',
      })

      const db = await runCli(
        dir,
        ['cloud', 'secrets', 'set', 'DATABASE_URL', '--mode', 'sandbox'],
        {
          env,
          input: 'postgres://u:p@db/x',
        },
      )
      assert.equal(db.code, 0, db.stderr)
      assert.match(db.stdout, /Added DATABASE_URL in proj_a: sandbox, version 1\./)

      const list = await runCli(dir, ['cloud', 'secrets', 'list'], { env })
      assert.equal(list.code, 0, list.stderr)
      assert.match(list.stdout, /2 secrets in proj_a:/)
      assert.match(list.stdout, /NAME\s+MODE\s+HOSTS\s+VERSION\s+UPDATED/)
      assert.match(
        list.stdout,
        /STRIPE_KEY\s+brokered\s+api\.stripe\.com, \*\.stripe\.net\s+2\s+2026-11-09 21:00 by ada@example\.com/,
      )
      assert.match(list.stdout, /DATABASE_URL\s+sandbox\s+-\s+1/)
      const asJson = JSON.parse(
        (await runCli(dir, ['cloud', 'secrets', 'list', '--json'], { env })).stdout,
      )
      assert.equal(asJson.projectId, 'proj_a')
      assert.equal(asJson.secrets.length, 2)

      const del = await runCli(dir, ['cloud', 'secrets', 'delete', 'STRIPE_KEY'], { env })
      assert.equal(del.code, 0, del.stderr)
      assert.match(del.stdout, /Deleted STRIPE_KEY from proj_a\./)
      const gone = await runCli(dir, ['cloud', 'secrets', 'delete', 'STRIPE_KEY'], { env })
      assert.equal(gone.code, 2)
      assert.match(gone.stderr, /No secret named STRIPE_KEY in proj_a/)
      for (const r of [set, again, db, list, del, gone]) never(r.stdout + r.stderr)
    } finally {
      await p.close()
    }
  })

  test('takes the value from the local environment with --from-env', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const r = await runCli(
        dir,
        ['cloud', 'secrets', 'set', 'FIXTURE_TOKEN', '--mode', 'readable', '--from-env'],
        {
          env: { ...env, FIXTURE_TOKEN: VALUE },
        },
      )
      assert.equal(r.code, 0, r.stderr)
      assert.equal(p.secrets.get('FIXTURE_TOKEN')?.value, VALUE)
      never(r.stdout + r.stderr)
      const missing = await runCli(
        dir,
        ['cloud', 'secrets', 'set', 'NOPE', '--mode', 'readable', '--from-env'],
        { env },
      )
      assert.equal(missing.code, 2)
      assert.match(missing.stderr, /--from-env: NOPE isn't set here/)
    } finally {
      await p.close()
    }
  })

  test('refuses a value on the command line, a brokered secret with no host and hosts on another mode', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const cases: [string[], RegExp][] = [
        [
          ['set', 'A', VALUE, '--host', 'a.example'],
          /not as an argument, which would land in your shell history/,
        ],
        [['set', 'A', '--mode', 'brokered'], /A brokered secret needs --host/],
        [
          ['set', 'A', '--mode', 'sandbox', '--host', 'a.example'],
          /--host is for a brokered secret/,
        ],
        [['set', 'A', '--mode', 'hidden'], /--mode is brokered, sandbox or readable$/m],
        [
          ['set', 'A', '--host', 'https://a.example/x'],
          /--host https:\/\/a\.example\/x isn't a host name/,
        ],
        [['set', '1A', '--host', 'a.example'], /the secret's name isn't one/],
        [['set', 'A', '--host', 'a.example', VALUE, 'x'], /takes at most 3 arguments \(got 4\)$/m],
        [['set', 'sk-live-0123', '--host', 'a.example'], /the secret's name isn't one/],
        [['set', 'NEW'], /NEW is a new secret: give --host <host> for a brokered one/],
        [['get', 'A'], /reeval cloud secrets needs set, delete or list$/m],
        [['set', 'A', `-${VALUE}`], /reeval cloud secrets has no such option/],
      ]
      for (const [args, message] of cases) {
        const r = await runCli(dir, ['cloud', 'secrets', ...args], { env, input: VALUE })
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, message, args.join(' '))
        never(r.stdout + r.stderr)
      }
      assert.equal(p.seen.filter((s) => s.method === 'PUT').length, 0, 'nothing was sent')
      const empty = await runCli(dir, ['cloud', 'secrets', 'set', 'A', '--host', 'a.example'], {
        env,
        input: '\n',
      })
      assert.equal(empty.code, 2)
      assert.match(empty.stderr, /A's value is empty/)
    } finally {
      await p.close()
    }
  })

  test("relays the platform's refusals: a member who isn't an admin, a signed-out machine, a URL that isn't http(s)", async () => {
    const p = await platform({ admin: false })
    try {
      const { dir, env } = linked(p.base)
      const r = await runCli(dir, ['cloud', 'secrets', 'set', 'A', '--host', 'a.example'], {
        env,
        input: VALUE,
      })
      assert.equal(r.code, 2)
      assert.match(
        r.stderr,
        /the cloud platform refused to set A: Only an admin of the project can change its secrets\. \(check REEVAL_TOKEN\)/,
      )
      never(r.stdout + r.stderr)
      const out = await runCli(dir, ['cloud', 'secrets', 'list'], {
        env: { ...env, REEVAL_TOKEN: '' },
      })
      assert.equal(out.code, 2)
      assert.match(out.stderr, /Sign in first\. \(reeval login signs in, or set REEVAL_TOKEN\)/)
      const noUrl = await runCli(dir, ['cloud', 'secrets', 'list'], {
        env: { ...env, REEVAL_CLOUD_URL: 'not-a-url' },
      })
      assert.equal(noUrl.code, 2)
      assert.match(noUrl.stderr, /REEVAL_CLOUD_URL is an http or https URL \(got not-a-url\)/)
    } finally {
      await p.close()
    }
  })

  test('without .reeval/project.json, takes --org and --project, by slug or id, anywhere', async () => {
    const p = await platform()
    try {
      const { env } = linked(p.base)
      const dir = tempDir('cloud-unlinked')
      const bare = await runCli(dir, ['cloud', 'secrets', 'list'], { env })
      assert.equal(bare.code, 2)
      assert.match(
        bare.stderr,
        /nothing is linked here: run reeval link, or pass --org and --project/,
      )
      const noOrg = await runCli(dir, ['cloud', 'secrets', 'list', '--project', 'app'], { env })
      assert.equal(noOrg.code, 2)
      assert.match(noOrg.stderr, /--project needs --org in reeval cloud secrets list/)
      const noProject = await runCli(dir, ['cloud', 'secrets', 'list', '--org', 'acme'], { env })
      assert.equal(noProject.code, 2)
      assert.match(
        noProject.stderr,
        /--org needs --project in reeval cloud secrets list: nothing is linked here/,
      )
      const key = await runCli(
        dir,
        ['cloud', 'provider', 'set', 'openai', '--org', 'acme', '--project', 'sk-proj-given'],
        { env, input: 'sk-proj-c3d4\n' },
      )
      assert.equal(key.code, 2)
      assert.match(key.stderr, /has no project by that name: pass --project with one of app, beta/)
      assert.ok(!/sk-proj/.test(key.stdout + key.stderr), 'no key is printed')
      const unknown = await runCli(
        dir,
        ['cloud', 'secrets', 'list', '--org', 'acme', '--project', 'nope'],
        { env },
      )
      assert.equal(unknown.code, 2)
      assert.match(
        unknown.stderr,
        /ACME \(acme\) has no project by that name: pass --project with one of app, beta/,
      )
      for (const args of [
        ['cloud', 'secrets', 'list', '--org', 'acme', '--project', 'app'],
        ['cloud', 'secrets', '--org=org_a', 'list', '--project', 'APP'],
        ['cloud', 'secrets', '--project', 'proj_a', 'list', '--org', 'ACME'],
      ]) {
        const r = await runCli(dir, args, { env })
        assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`)
        assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/projects/proj_a/secrets')
      }
    } finally {
      await p.close()
    }
  })

  test('--project names another project in the linked org', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const r = await runCli(dir, ['cloud', 'secrets', 'delete', 'TOKEN', '--project', 'beta'], {
        env,
      })
      assert.equal(r.code, 2)
      assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/projects/proj_b/secrets/TOKEN')
    } finally {
      await p.close()
    }
  })
})

/** Runs each refused command and checks its argument is in no output, request or log line. */
async function refusesUnsaid(
  cases: { args: string[]; secret: string; message: RegExp }[],
  area: 'provider' | 'gateway' = 'provider',
): Promise<void> {
  const p = await platform()
  try {
    const { dir, env } = linked(p.base)
    for (const { args, secret, message } of cases) {
      const before = p.seen.length
      const r = await runCli(dir, ['cloud', area, ...args], {
        env,
        input: 'real-key-q7w8\n',
      })
      const said = r.stdout + r.stderr
      assert.equal(r.code, 2, `${JSON.stringify(args)}: ${said}`)
      assert.match(r.stderr, message, JSON.stringify(args))
      // `.` and `..` are in any sentence; their sign is the request they don't make.
      if (secret.length > 2) {
        assert.ok(!said.includes(secret), `${JSON.stringify(secret)} is repeated: ${said}`)
      }
      assert.ok(!said.includes('\u001b'), `an escape sequence reached the terminal: ${said}`)
      const sent = p.seen.slice(before)
      assert.deepEqual(
        sent.filter((s) => s.method !== 'GET'),
        [],
        `${JSON.stringify(args)} sent a write`,
      )
      assert.ok(!JSON.stringify(sent).includes('real-key-q7w8'), 'the key was sent')
      assert.ok(!JSON.stringify(sent).includes(encodeURIComponent(secret)), 'it was sent')
    }
    const log = readFileSync(join(dir, '.reeval', 'cli.jsonl'), 'utf8')
    for (const { secret } of cases.filter((c) => c.secret.length > 2)) {
      assert.ok(!log.includes(secret), `${JSON.stringify(secret)} is in the command log`)
      assert.ok(!log.includes(JSON.stringify(secret).slice(1, -1)), 'escaped, it is in the log')
    }
  } finally {
    await p.close()
  }
}

describe('reeval cloud provider', () => {
  test("sets, lists and deletes the org's key and a project's override", async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const org = await runCli(dir, ['cloud', 'provider', 'set', 'openai'], {
        env,
        input: 'sk-org-a1b2\n',
      })
      assert.equal(org.code, 0, org.stderr)
      assert.match(org.stdout, /Added the openai key for org_a \(…a1b2\), version 1\./)
      assert.deepEqual(JSON.parse(p.seen.at(-1)?.body ?? ''), { key: 'sk-org-a1b2' })
      const project = await runCli(
        dir,
        ['cloud', 'provider', 'set', 'openai', '--project', 'app'],
        { env, input: 'sk-proj-c3d4' },
      )
      assert.equal(project.code, 0, project.stderr)
      assert.match(project.stdout, /Added the openai key for proj_a \(…c3d4\), version 1\./)
      assert.deepEqual(JSON.parse(p.seen.at(-1)?.body ?? ''), {
        key: 'sk-proj-c3d4',
        projectId: 'proj_a',
      })

      const list = await runCli(dir, ['cloud', 'provider', 'list'], { env })
      assert.equal(list.code, 0, list.stderr)
      assert.match(list.stdout, /2 provider keys in org_a:/)
      assert.match(list.stdout, /openai\s+the org\s+…a1b2\s+1/)
      assert.match(list.stdout, /openai\s+proj_a\s+…c3d4\s+1/)

      const del = await runCli(dir, ['cloud', 'provider', '--project', 'app', 'delete', 'openai'], {
        env,
      })
      assert.equal(del.code, 0, del.stderr)
      assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/providers/openai?projectId=proj_a')
      assert.match(del.stdout, /Deleted the openai key for proj_a\./)
      const gone = await runCli(dir, ['cloud', 'provider', 'delete', 'openai', '--project=APP'], {
        env,
      })
      assert.equal(gone.code, 2)
      assert.match(gone.stderr, /No openai key for proj_a/)
      for (const r of [org, project, list, del]) {
        assert.ok(!/sk-org|sk-proj/.test(r.stdout + r.stderr), 'no key is printed')
      }
    } finally {
      await p.close()
    }
  })

  test('without .reeval/project.json, takes the org from --org', async () => {
    const p = await platform()
    try {
      const { env } = linked(p.base)
      const dir = tempDir('cloud-unlinked')
      const bare = await runCli(dir, ['cloud', 'provider', 'list'], { env })
      assert.equal(bare.code, 2)
      assert.match(
        bare.stderr,
        /acts on the linked org, and nothing is linked here: run reeval link, or pass --org$/m,
      )
      const listed = await runCli(dir, ['cloud', 'provider', 'list', '--project', 'app'], { env })
      assert.equal(listed.code, 2)
      assert.match(listed.stderr, /takes --org, not --project/)
      const r = await runCli(dir, ['cloud', 'provider', 'set', 'openai', '--org', 'acme'], {
        env,
        input: 'sk-org-a1b2\n',
      })
      assert.equal(r.code, 0, r.stderr)
      assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/providers/openai')
      assert.deepEqual(JSON.parse(p.seen.at(-1)?.body ?? ''), { key: 'sk-org-a1b2' })
    } finally {
      await p.close()
    }
  })

  test("sets and deletes the key for Typesafe's typesafe-ai judges", async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const set = await runCli(dir, ['cloud', 'provider', 'set', 'typesafe-ai'], {
        env,
        input: 'ts-key-e5f6\n',
      })
      assert.equal(set.code, 0, set.stderr)
      assert.match(set.stdout, /Added the typesafe-ai key for org_a \(…e5f6\), version 1\./)
      assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/providers/typesafe-ai')
      assert.deepEqual(JSON.parse(p.seen.at(-1)?.body ?? ''), { key: 'ts-key-e5f6' })
      const del = await runCli(dir, ['cloud', 'provider', 'delete', 'typesafe-ai'], { env })
      assert.equal(del.code, 0, del.stderr)
      assert.match(del.stdout, /Deleted the typesafe-ai key for org_a\./)
    } finally {
      await p.close()
    }
  })

  test('refuses before reading the value when signed out, and a brokered value with a line break', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const out = await runCli(dir, ['cloud', 'secrets', 'set', 'A', '--host', 'a.example'], {
        env: { ...env, REEVAL_TOKEN: '' },
        input: VALUE,
      })
      assert.equal(out.code, 2, out.stdout + out.stderr)
      assert.match(
        out.stderr,
        /reeval cloud secrets set needs you signed in: reeval login signs in/,
      )
      const wrapped = await runCli(dir, ['cloud', 'secrets', 'set', 'A', '--host', 'a.example'], {
        env,
        input: `${VALUE.slice(0, 10)}\n${VALUE.slice(10)}`,
      })
      assert.equal(wrapped.code, 2, wrapped.stdout + wrapped.stderr)
      assert.match(wrapped.stderr, /A's value has whitespace or a control character at position 11/)
      assert.equal(p.seen.filter((s) => s.method === 'PUT').length, 0)
      // Twin: a sandbox value may hold one.
      const sandbox = await runCli(dir, ['cloud', 'secrets', 'set', 'A', '--mode', 'sandbox'], {
        env,
        input: `${VALUE.slice(0, 10)}\n${VALUE.slice(10)}`,
      })
      assert.equal(sandbox.code, 0, sandbox.stdout + sandbox.stderr)
    } finally {
      await p.close()
    }
  })

  test("doesn't follow a redirect with the value", async () => {
    const p = await platform()
    const hops: string[] = []
    const relay = createServer((req, res) => {
      hops.push(req.method ?? '')
      res.writeHead(307, { location: `${p.base}${req.url}` })
      res.end()
    })
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
    try {
      const { dir, env } = linked(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`)
      const out = await runCli(dir, ['cloud', 'secrets', 'set', 'A', '--mode', 'sandbox'], {
        env,
        input: VALUE,
      })
      assert.equal(out.code, 3, out.stdout + out.stderr)
      never(out.stdout + out.stderr)
      assert.deepEqual(hops, ['PUT'])
      assert.equal(p.seen.length, 0, 'the redirect target never hears from reeval')
    } finally {
      relay.closeAllConnections()
      await new Promise((resolve) => relay.close(resolve))
      await p.close()
    }
  })

  test("sends any provider name, encoded, and passes on the platform's refusal", async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const set = await runCli(dir, ['cloud', 'provider', 'set', 'openrouter'], {
        env,
        input: 'or-key-c3d4\n',
      })
      assert.equal(set.code, 0, set.stderr)
      assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/providers/openrouter')
      const refused = await runCli(dir, ['cloud', 'provider', 'set', 'acme'], {
        env,
        input: 'acme-key-9z8y\n',
      })
      assert.equal(refused.code, 2, refused.stdout + refused.stderr)
      assert.match(
        refused.stderr,
        /the cloud platform refused to set the acme key: acme isn't a provider this org can use\.$/m,
      )
      assert.doesNotMatch(refused.stdout + refused.stderr, /acme-key-9z8y|9z8y/)
    } finally {
      await p.close()
    }
  })

  test('refuses a name that is no slug, dot segments included, without repeating or sending it', async () => {
    const slug =
      /needs a provider's slug: lowercase letters and digits, joined by -, _ or \., at most 64\. reeval doesn't repeat it/
    await refusesUnsaid(
      [
        '..',
        '.',
        'a/..',
        'Open AI/x?y',
        'OpenAI',
        'openai-',
        'open..ai',
        'open\nai',
        'open\u001b[31mai',
      ].flatMap((name) =>
        ['set', 'delete'].map((action) => ({ args: [action, name], secret: name, message: slug })),
      ),
    )
  })

  test('refuses a key in any position, the old order included, without repeating or sending it', async () => {
    const unknown =
      /reeval cloud provider has no such subcommand: reeval cloud provider set <provider>, delete <provider> or list$/m
    const asKey = /that looks like a key, not a provider name/
    const keys = [
      'abcd1234efgh5678',
      'csk-abcdefgh12345678',
      'sk-proj-Abc123def456',
      'deadbeefcafe0123',
    ]
    await refusesUnsaid([
      // The old order, and a key where the subcommand goes.
      ...['set', 'delete'].flatMap((action) =>
        keys.map((key) => ({ args: [key, action], secret: key, message: unknown })),
      ),
      { args: ['vercel', 'set'], secret: 'vercel', message: unknown },
      { args: ['anthropic', 'delete'], secret: 'anthropic', message: unknown },
      { args: ['rotate', 'openai'], secret: 'rotate', message: unknown },
      // A key as the name.
      ...['set', 'delete'].flatMap((action) =>
        ['csk-ab12', 'sk-proj-Abc123def456', 'k3Jd9fQ2mZp7Lx4Rv8Wn'].map((key) => ({
          args: [action, key],
          secret: key,
          message: asKey,
        })),
      ),
      // A key as a third argument.
      {
        args: ['set', 'openai', 'abcd1234efgh5678'],
        secret: 'abcd1234efgh5678',
        message:
          /reeval cloud provider set openai takes the value on stdin or at its prompt, not as an argument/,
      },
      {
        args: ['delete', 'openai', 'abcd1234efgh5678'],
        secret: 'abcd1234efgh5678',
        message: /reeval cloud provider delete openai takes no value$/m,
      },
    ])
  })

  test('sends a dotted or underscored slug to its own route', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      for (const name of ['my.provider', 'snake_case', 'openai.compat-v2']) {
        const r = await runCli(dir, ['cloud', 'provider', 'delete', name], { env })
        assert.match(r.stderr, /No .* key for org_a/, name)
        assert.equal(p.seen.at(-1)?.path, `/api/orgs/org_a/providers/${name}`)
      }
    } finally {
      await p.close()
    }
  })

  test("refuses a provider name that looks like a key, and doesn't repeat or send it", async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const keys = [
        'sk-proj-Abc123def456',
        'sk_live_9f8e7d6c',
        'AIzaSyD3fG4hJ5kL6',
        'gsk_0a1b2c3d',
        'xai-QwErTy12',
        'k3Jd9fQ2mZp7Lx4Rv8Wn',
        'a8f3c91e7b2d4f60c5e9',
        'p'.repeat(65),
      ]
      for (const key of keys) {
        for (const action of ['set', 'delete']) {
          const r = await runCli(dir, ['cloud', 'provider', action, key], { env, input: 'k\n' })
          const said = r.stdout + r.stderr
          assert.equal(r.code, 2, `${key} ${action}: ${said}`)
          assert.match(r.stderr, /that looks like a key, not a provider name/, key)
          assert.ok(!said.includes(key), `${key} is repeated: ${said}`)
        }
      }
      const sent = JSON.stringify(p.seen)
      for (const key of keys) assert.ok(!sent.includes(key), `${key} reached the platform`)
      assert.equal(p.seen.filter((s) => s.method !== 'GET').length, 0)
      const log = readFileSync(join(dir, '.reeval', 'cli.jsonl'), 'utf8')
      for (const key of keys) assert.ok(!log.includes(key), `${key} is in the command log`)
      // Twins: provider slugs, long or with digits, still go to the platform.
      for (const name of ['google-vertex-anthropic', 'amazon-bedrock', 'xai', 'r1-provider-2']) {
        const r = await runCli(dir, ['cloud', 'provider', 'delete', name], { env })
        assert.match(r.stderr, /No .* key for org_a/, name)
        assert.equal(p.seen.at(-1)?.path, `/api/orgs/org_a/providers/${name}`)
      }
    } finally {
      await p.close()
    }
  })

  test('refuses a key on the command line and a key with whitespace', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const cases: [string[], string, RegExp][] = [
        [
          ['set', 'openai', 'sk-x'],
          'k',
          /not as an argument, which would land in your shell history/,
        ],
        [['set', 'openai'], 'sk x', /whitespace or a control character at position 3/],
        [
          ['set'],
          'k',
          /reeval cloud provider set needs the provider: reeval cloud provider set <provider>$/m,
        ],
        [[], 'k', /has no such subcommand/],
        [['set', 'openai', '--sk-proj-Abc123'], 'k', /reeval cloud provider has no such option/],
      ]
      for (const [args, input, message] of cases) {
        const r = await runCli(dir, ['cloud', 'provider', ...args], { env, input })
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, message, args.join(' '))
      }
      assert.equal(p.seen.filter((s) => s.method === 'PUT').length, 0)
    } finally {
      await p.close()
    }
  })
})

describe('reeval cloud gateway', () => {
  test("sets, lists and deletes the org's key and a project's override", async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const org = await runCli(dir, ['cloud', 'gateway', 'set', 'vercel'], {
        env,
        input: 'vck-org-a1b2\n',
      })
      assert.equal(org.code, 0, org.stderr)
      assert.match(org.stdout, /Added the vercel key for org_a \(…a1b2\), version 1\./)
      assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/gateways/vercel')
      assert.deepEqual(JSON.parse(p.seen.at(-1)?.body ?? ''), { key: 'vck-org-a1b2' })
      const project = await runCli(
        dir,
        ['cloud', 'gateway', 'set', 'openrouter', '--project', 'app'],
        { env, input: 'sk-or-proj-c3d4' },
      )
      assert.equal(project.code, 0, project.stderr)
      assert.match(project.stdout, /Added the openrouter key for proj_a \(…c3d4\), version 1\./)
      assert.deepEqual(JSON.parse(p.seen.at(-1)?.body ?? ''), {
        key: 'sk-or-proj-c3d4',
        projectId: 'proj_a',
      })
      const again = await runCli(dir, ['cloud', 'gateway', 'set', 'vercel'], {
        env,
        input: 'vck-org-e5f6\n',
      })
      assert.match(again.stdout, /Replaced the vercel key for org_a \(…e5f6\), version 2\./)

      const list = await runCli(dir, ['cloud', 'gateway', 'list'], { env })
      assert.equal(list.code, 0, list.stderr)
      assert.match(list.stdout, /2 gateway keys in org_a:/)
      assert.match(list.stdout, /GATEWAY\s+FOR\s+KEY/)
      assert.match(list.stdout, /vercel\s+the org\s+…e5f6\s+2/)
      assert.match(list.stdout, /openrouter\s+proj_a\s+…c3d4\s+1/)
      const json = await runCli(dir, ['cloud', 'gateway', 'list', '--json'], { env })
      assert.deepEqual(
        (JSON.parse(json.stdout) as { gateways: { gateway: string }[] }).gateways.map(
          (g) => g.gateway,
        ),
        ['vercel', 'openrouter'],
      )
      const providers = await runCli(dir, ['cloud', 'provider', 'list'], { env })
      assert.match(providers.stdout, /No provider keys in org_a/)

      const del = await runCli(
        dir,
        ['cloud', 'gateway', 'delete', 'openrouter', '--project', 'app'],
        { env },
      )
      assert.equal(del.code, 0, del.stderr)
      assert.equal(p.seen.at(-1)?.path, '/api/orgs/org_a/gateways/openrouter?projectId=proj_a')
      assert.match(del.stdout, /Deleted the openrouter key for proj_a\./)
      const gone = await runCli(dir, ['cloud', 'gateway', 'delete', 'openrouter'], { env })
      assert.equal(gone.code, 2)
      assert.match(gone.stderr, /No openrouter key for org_a/)
      for (const r of [org, project, again, list, json, del]) {
        assert.ok(!/vck-org|sk-or-proj/.test(r.stdout + r.stderr), 'no key is printed')
      }
    } finally {
      await p.close()
    }
  })

  test("passes on the platform's refusal of a gateway it doesn't serve, without the key", async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const r = await runCli(dir, ['cloud', 'gateway', 'set', 'vertex'], {
        env,
        input: 'vertex-key-9z8y\n',
      })
      assert.equal(r.code, 2, r.stdout + r.stderr)
      assert.match(
        r.stderr,
        /the cloud platform refused to set the vertex key: vertex isn't a gateway this org can use\.$/m,
      )
      assert.doesNotMatch(r.stdout + r.stderr, /vertex-key-9z8y|9z8y/)
    } finally {
      await p.close()
    }
  })

  test('refuses a name that is no slug, a key in any position and an unknown subcommand, without repeating or sending it', async () => {
    const slug =
      /needs a gateway's name: lowercase letters and digits, joined by -, _ or \., at most 64\. reeval doesn't repeat it/
    const unknown =
      /reeval cloud gateway has no such subcommand: reeval cloud gateway set <gateway>, delete <gateway> or list$/m
    const asKey = /that looks like a key, not a gateway name, so reeval didn't send or repeat it/
    await refusesUnsaid(
      [
        ...['..', '.', 'a/..', 'Vercel', 'vercel-', 'open\nrouter', 'ver\u001b[31mcel'].flatMap(
          (name) =>
            ['set', 'delete'].map((action) => ({
              args: [action, name],
              secret: name,
              message: slug,
            })),
        ),
        ...['set', 'delete'].flatMap((action) =>
          ['vck_0a1b2c3d4e5f', 'sk-or-v1-Abc123def456', 'k3Jd9fQ2mZp7Lx4Rv8Wn'].map((key) => ({
            args: [action, key],
            secret: key,
            message: asKey,
          })),
        ),
        { args: ['abcd1234efgh5678', 'set'], secret: 'abcd1234efgh5678', message: unknown },
        { args: ['openrouter', 'set'], secret: 'openrouter', message: unknown },
        { args: ['rotate', 'openrouter'], secret: 'rotate', message: unknown },
        {
          args: ['set', 'vercel', 'abcd1234efgh5678'],
          secret: 'abcd1234efgh5678',
          message:
            /reeval cloud gateway set vercel takes the value on stdin or at its prompt, not as an argument/,
        },
        {
          args: ['delete', 'vercel', 'abcd1234efgh5678'],
          secret: 'abcd1234efgh5678',
          message: /reeval cloud gateway delete vercel takes no value$/m,
        },
      ],
      'gateway',
    )
  })

  test('refuses a key with whitespace, a missing name and list arguments', async () => {
    const p = await platform()
    try {
      const { dir, env } = linked(p.base)
      const cases: [string[], string, RegExp][] = [
        [['set', 'vercel'], 'vck x', /whitespace or a control character at position 4/],
        [
          ['set'],
          'k',
          /reeval cloud gateway set needs the gateway: reeval cloud gateway set <gateway>$/m,
        ],
        [[], 'k', /has no such subcommand/],
        [['list', 'vercel'], 'k', /reeval cloud gateway list takes no arguments/],
        [['list', '--project', 'app'], 'k', /takes --org, not --project/],
      ]
      for (const [args, input, message] of cases) {
        const r = await runCli(dir, ['cloud', 'gateway', ...args], { env, input })
        assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        assert.match(r.stderr, message, args.join(' '))
        assert.ok(!(r.stdout + r.stderr).includes('vck x'), 'the key is never printed')
      }
      assert.equal(p.seen.filter((s) => s.method === 'PUT').length, 0)
    } finally {
      await p.close()
    }
  })
})
