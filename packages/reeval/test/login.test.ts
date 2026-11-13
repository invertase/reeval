// `reeval login`, `logout` and `whoami` against a fake platform that runs the device flow
// (RFC 8628) and answers `/api/me` for the tokens it gave out.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { delimiter, dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { platformKey } from '../src/login/credentials.ts'
import { runCli, tempDir } from './helpers.ts'

const TOKEN = 'session-token-from-the-device-flow'
const USER = { id: 'user_1', email: 'ada@example.com', name: 'Ada Lovelace' }

type Seen = { method: string; path: string; auth?: string; origin?: string; body: string }

/**
 * The platform's sign-in routes. `/device/token` answers `authorization_pending` `pending` times,
 * then `outcome`: the token, `access_denied`, `expired_token` or a 403 refusal.
 */
async function platform(
  options: {
    pending?: number
    outcome?: 'token' | 'denied' | 'expired' | 'refused'
    /** The approval page it sends, instead of its own. */
    page?: string
  } = {},
) {
  const seen: Seen[] = []
  const live = new Set<string>()
  let polls = 0
  let issued = 0
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => resolve(body))
    })
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    const body = await read(req)
    seen.push({
      method: req.method ?? '',
      path: url.pathname,
      ...(req.headers.authorization && { auth: req.headers.authorization }),
      ...(req.headers.origin && { origin: req.headers.origin }),
      body,
    })
    const bearer = req.headers.authorization?.replace(/^Bearer /, '')
    if (req.method === 'POST' && url.pathname === '/api/auth/device/code') {
      if (JSON.parse(body).client_id !== 'reeval-cli') {
        return json(res, 400, { error: 'invalid_client', error_description: 'Invalid client ID' })
      }
      return json(res, 200, {
        device_code: 'device-code-1',
        user_code: 'ABCD-EFGH',
        verification_uri: `${base}/device`,
        verification_uri_complete: options.page ?? `${base}/device?user_code=ABCD-EFGH`,
        expires_in: 60,
        interval: 0,
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/device/token') {
      const sent = JSON.parse(body)
      assert.equal(sent.grant_type, 'urn:ietf:params:oauth:grant-type:device_code')
      assert.equal(sent.device_code, 'device-code-1')
      assert.equal(sent.client_id, 'reeval-cli')
      if (polls++ < (options.pending ?? 2)) {
        return json(res, 400, { error: 'authorization_pending', error_description: 'pending' })
      }
      switch (options.outcome ?? 'token') {
        case 'denied':
          return json(res, 400, { error: 'access_denied', error_description: 'denied' })
        case 'expired':
          return json(res, 400, { error: 'expired_token', error_description: 'expired' })
        case 'refused':
          return json(res, 403, {
            code: 'ACCOUNT_NOT_ALLOWED',
            message: "This account can't sign in.",
          })
      }
      const token = issued++ ? `${TOKEN}-${issued}` : TOKEN
      live.add(token)
      return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 604800 })
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      if (!bearer || !live.has(bearer)) {
        return json(res, 401, { error: { code: 'unauthorized', message: 'Sign in first.' } })
      }
      return json(res, 200, { user: { ...USER, emailVerified: true } })
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/sign-out') {
      if (bearer) live.delete(bearer)
      return json(res, 200, { success: true })
    }
    json(res, 404, { error: { code: 'not_found', message: `no route ${url.pathname}` } })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    live,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A machine with no keychain reeval uses: the token goes in the credentials file. */
function machine(base: string, extra: NodeJS.ProcessEnv = {}) {
  const config = tempDir('login-config')
  return {
    config,
    file: join(config, 'reeval/credentials.json'),
    env: {
      REEVAL_CLOUD_URL: base,
      XDG_CONFIG_HOME: config,
      REEVAL_NO_KEYCHAIN: '1',
      ...extra,
    } as NodeJS.ProcessEnv,
  }
}

const SIGNED_IN = '2026-11-01T00:00:00Z'

/** Writes a credentials file holding `logins`, as an earlier `reeval login` would have. */
function stored(file: string, logins: Record<string, unknown>) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, logins }))
}

/**
 * A fake `secret-tool` on `PATH`: a keyring of one file per account, and the arguments of every
 * call in `log`.
 */
function secretTool() {
  const bin = tempDir('login-bin')
  const store = tempDir('login-keyring')
  const log = join(store, 'argv.log')
  writeFileSync(
    join(bin, 'secret-tool'),
    `#!/bin/sh
echo "$@" >> "${log}"
cmd=$1; shift
key=$(echo "$*" | sed 's/.*account //' | tr -c 'a-zA-Z0-9' '_')
case $cmd in
  store) cat > "${store}/$key" ;;
  lookup) [ -f "${store}/$key" ] && cat "${store}/$key" || exit 1 ;;
  clear) rm -f "${store}/$key" ;;
esac
`,
  )
  chmodSync(join(bin, 'secret-tool'), 0o755)
  return {
    log,
    /** Puts `token` in the keyring under `account`, as `secret-tool store` would. */
    seed: (account: string, token: string) =>
      writeFileSync(join(store, `${account}\n`.replace(/[^a-zA-Z0-9]/g, '_')), token),
    env: {
      REEVAL_NO_KEYCHAIN: '',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fake',
      PATH: `${bin}${delimiter}${process.env.PATH}`,
    },
  }
}

describe('reeval login, whoami and logout', () => {
  test('signs in with the device flow, keeps the token in a 0600 file, and signs out', async () => {
    const p = await platform()
    try {
      const m = machine(p.base)
      const dir = tempDir('login-cwd')
      const login = await runCli(dir, ['login'], { env: m.env })
      assert.equal(login.code, 0, login.stdout + login.stderr)
      assert.match(
        login.stdout,
        new RegExp(
          `Open ${p.base}/device\\?user_code=ABCD-EFGH and check it shows the code ABCD-EFGH`,
        ),
      )
      assert.match(
        login.stdout,
        new RegExp(
          `Signed in to ${p.base} as Ada Lovelace <ada@example.com>; the token is in .*credentials\\.json`,
        ),
      )
      assert.ok(!login.stdout.includes(TOKEN), 'the token is never printed')
      assert.equal(p.seen.filter((s) => s.path === '/api/auth/device/token').length, 3)
      const saved = JSON.parse(readFileSync(m.file, 'utf8'))
      assert.equal(saved.schemaVersion, 1)
      assert.deepEqual(saved.logins[p.base].user, USER)
      assert.equal(saved.logins[p.base].store, 'file')
      assert.equal(saved.logins[p.base].token, TOKEN)
      if (process.platform !== 'win32') assert.equal(statSync(m.file).mode & 0o777, 0o600)

      const who = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(who.code, 0, who.stdout + who.stderr)
      assert.match(
        who.stdout,
        new RegExp(
          `Signed in to ${p.base} as Ada Lovelace <ada@example.com> \\(token from .*credentials\\.json\\)`,
        ),
      )
      assert.equal(p.seen.at(-1)?.auth, `Bearer ${TOKEN}`)
      const asJson = await runCli(dir, ['whoami', '--json'], { env: m.env })
      assert.equal(asJson.code, 0, asJson.stderr)
      const doc = JSON.parse(asJson.stdout)
      assert.equal(doc.url, p.base)
      assert.deepEqual(doc.user, USER)
      assert.equal(doc.tokenFrom, m.file)

      const out = await runCli(dir, ['logout'], { env: m.env })
      assert.equal(out.code, 0, out.stdout + out.stderr)
      assert.match(
        out.stdout,
        new RegExp(`Signed out of ${p.base} \\(Ada Lovelace <ada@example.com>\\)`),
      )
      const signOut = p.seen.find((s) => s.path === '/api/auth/sign-out')
      assert.equal(signOut?.auth, `Bearer ${TOKEN}`)
      assert.equal(signOut?.origin, p.base)
      assert.ok(!p.live.has(TOKEN), 'the session is revoked on the platform')
      assert.ok(!existsSync(m.file), 'the last sign-in removed takes the file with it')

      const gone = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(gone.code, 2)
      assert.match(gone.stderr, /Not signed in to .*: reeval login signs in, or set REEVAL_TOKEN/)
      const again = await runCli(dir, ['logout'], { env: m.env })
      assert.equal(again.code, 0)
      assert.match(again.stdout, /Not signed in to .* with reeval login/)
    } finally {
      await p.close()
    }
  })

  test('a second login replaces the first and revokes its session', async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(p.base)
      const dir = tempDir('login-cwd')
      assert.equal((await runCli(dir, ['login'], { env: m.env })).code, 0)
      const second = await runCli(dir, ['login'], { env: m.env })
      assert.equal(second.code, 0, second.stdout + second.stderr)
      assert.ok(!p.live.has(TOKEN), 'the first sign-in is revoked')
      assert.ok(p.live.has(`${TOKEN}-2`))
      const saved = JSON.parse(readFileSync(m.file, 'utf8'))
      assert.equal(saved.logins[p.base].token, `${TOKEN}-2`)
    } finally {
      await p.close()
    }
  })

  test('keeps the token in the Secret Service through secret-tool, never on its command line', {
    skip: process.platform !== 'linux' && 'secret-tool is the Linux keychain',
  }, async () => {
    const p = await platform({ pending: 0 })
    try {
      const { log, env } = secretTool()
      const m = machine(p.base, env)
      const dir = tempDir('login-cwd')
      const login = await runCli(dir, ['login'], { env: m.env })
      assert.equal(login.code, 0, login.stdout + login.stderr)
      assert.match(login.stdout, /the token is in the Secret Service keyring/)
      const saved = JSON.parse(readFileSync(m.file, 'utf8'))
      assert.equal(saved.logins[p.base].store, 'keychain')
      assert.equal(saved.logins[p.base].token, undefined, 'no token in the file')
      assert.ok(!readFileSync(m.file, 'utf8').includes(TOKEN))
      const who = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(who.code, 0, who.stdout + who.stderr)
      assert.match(who.stdout, /\(token from the Secret Service keyring\)/)
      assert.equal(p.seen.at(-1)?.auth, `Bearer ${TOKEN}`)
      assert.equal((await runCli(dir, ['logout'], { env: m.env })).code, 0)
      assert.ok(!p.live.has(TOKEN))
      const argv = readFileSync(log, 'utf8')
      assert.match(argv, /^store /m)
      assert.match(argv, /^clear /m)
      for (const line of argv.trim().split('\n')) {
        assert.ok(line.endsWith(`account ${p.base}`), `keyed by the bare origin: ${line}`)
      }
      assert.ok(!argv.includes(TOKEN), 'the token never reaches a command line')
      const lookup = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(lookup.code, 2)

      // Signed in through the keychain, then in a shell that can't reach it.
      assert.equal((await runCli(dir, ['login'], { env: m.env })).code, 0)
      const away = { ...m.env, DBUS_SESSION_BUS_ADDRESS: '' }
      const lost = await runCli(dir, ['whoami'], { env: away })
      assert.equal(lost.code, 2)
      assert.match(
        lost.stderr,
        /but the keychain didn't return its token: reeval login signs in again/,
      )
      const half = await runCli(dir, ['logout'], { env: away })
      assert.equal(half.code, 0)
      assert.match(half.stderr, /wasn't revoked on the platform and the keychain may still hold it/)
      assert.match(half.stdout, /Removed the sign-in to .* from this machine's credentials/)
    } finally {
      await p.close()
    }
  })

  test('every spelling of REEVAL_CLOUD_URL is one sign-in, keyed by the bare origin', async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(`${p.base}/`)
      const dir = tempDir('login-cwd')
      const login = await runCli(dir, ['login'], { env: m.env })
      assert.equal(login.code, 0, login.stdout + login.stderr)
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(m.file, 'utf8')).logins), [p.base])
      const upper = p.base.replace('http://', 'HTTP://')
      for (const url of [p.base, upper, `${upper}/`]) {
        const who = await runCli(dir, ['whoami'], { env: { ...m.env, REEVAL_CLOUD_URL: url } })
        assert.equal(who.code, 0, `${url}: ${who.stdout}${who.stderr}`)
        assert.match(who.stdout, new RegExp(`Signed in to ${p.base} as `))
        const asJson = await runCli(dir, ['whoami', '--json'], {
          env: { ...m.env, REEVAL_CLOUD_URL: url },
        })
        assert.equal(JSON.parse(asJson.stdout).url, p.base, `${url}: no trailing /`)
      }
      const out = await runCli(dir, ['logout'], { env: { ...m.env, REEVAL_CLOUD_URL: upper } })
      assert.match(out.stdout, /Signed out of /)
      assert.ok(!existsSync(m.file), 'logout under another spelling removes the sign-in')
    } finally {
      await p.close()
    }
  })

  test('a sign-in stored under the URL with a trailing / still signs in, until login replaces it', async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(p.base)
      const dir = tempDir('login-cwd')
      const slashed = `${p.base}/`
      const login = {
        store: 'file',
        token: 'old-token',
        user: USER,
        signedInAt: '2026-11-01T00:00:00Z',
      }
      mkdirSync(join(m.config, 'reeval'), { recursive: true })
      writeFileSync(m.file, JSON.stringify({ schemaVersion: 1, logins: { [slashed]: login } }))
      p.live.add('old-token')
      const who = await runCli(dir, ['whoami', '--json'], { env: m.env })
      assert.equal(who.code, 0, who.stdout + who.stderr)
      assert.equal(JSON.parse(who.stdout).url, p.base)
      assert.equal(p.seen.at(-1)?.auth, 'Bearer old-token')
      assert.ok(!who.stdout.includes('old-token'), 'the token is never printed')

      assert.equal((await runCli(dir, ['login'], { env: m.env })).code, 0)
      assert.ok(!p.live.has('old-token'), 'the old sign-in is revoked')
      const saved = JSON.parse(readFileSync(m.file, 'utf8'))
      assert.deepEqual(Object.keys(saved.logins), [p.base])

      writeFileSync(
        m.file,
        JSON.stringify({ schemaVersion: 1, logins: { ...saved.logins, [slashed]: login } }),
      )
      const out = await runCli(dir, ['logout'], { env: m.env })
      assert.equal(out.code, 0, out.stdout + out.stderr)
      assert.ok(!existsSync(m.file), 'logout removes every spelling of the sign-in')
    } finally {
      await p.close()
    }
  })

  test('a keychain sign-in under the URL with a trailing / still signs in, and logout clears it', {
    skip: process.platform !== 'linux' && 'secret-tool is the Linux keychain',
  }, async () => {
    const p = await platform({ pending: 0 })
    try {
      const { log, seed, env } = secretTool()
      const m = machine(p.base, env)
      const dir = tempDir('login-cwd')
      const slashed = `${p.base}/`
      const login = { store: 'keychain', user: USER, signedInAt: '2026-11-01T00:00:00Z' }
      mkdirSync(join(m.config, 'reeval'), { recursive: true })
      writeFileSync(m.file, JSON.stringify({ schemaVersion: 1, logins: { [slashed]: login } }))
      seed(slashed, 'old-token')
      p.live.add('old-token')
      const who = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(who.code, 0, who.stdout + who.stderr)
      assert.match(who.stdout, /\(token from the Secret Service keyring\)/)
      assert.equal(p.seen.at(-1)?.auth, 'Bearer old-token')

      const out = await runCli(dir, ['logout'], { env: m.env })
      assert.equal(out.code, 0, out.stdout + out.stderr)
      assert.ok(!p.live.has('old-token'), 'the session is revoked on the platform')
      assert.ok(!existsSync(m.file))
      assert.match(readFileSync(log, 'utf8'), new RegExp(`^clear .*account ${slashed}$`, 'm'))
      const gone = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(gone.code, 2)
    } finally {
      await p.close()
    }
  })

  test('login replaces a keychain sign-in under the URL with a trailing /, revoking it', {
    skip: process.platform !== 'linux' && 'secret-tool is the Linux keychain',
  }, async () => {
    const p = await platform({ pending: 0 })
    try {
      const { log, seed, env } = secretTool()
      const m = machine(p.base, env)
      const dir = tempDir('login-cwd')
      const slashed = `${p.base}/`
      stored(m.file, { [slashed]: { store: 'keychain', user: USER, signedInAt: SIGNED_IN } })
      seed(slashed, 'old-token')
      p.live.add('old-token')

      const login = await runCli(dir, ['login'], { env: m.env })
      assert.equal(login.code, 0, login.stdout + login.stderr)
      assert.ok(!p.live.has('old-token'), 'the slashed sign-in is revoked')
      const saved = JSON.parse(readFileSync(m.file, 'utf8'))
      assert.deepEqual(Object.keys(saved.logins), [p.base])
      assert.equal(saved.logins[p.base].store, 'keychain')
      const argv = readFileSync(log, 'utf8')
      assert.match(argv, new RegExp(`^store .*account ${p.base}$`, 'm'))
      assert.match(argv, new RegExp(`^clear .*account ${slashed}$`, 'm'))
      const who = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(who.code, 0, who.stdout + who.stderr)
      assert.equal(p.seen.at(-1)?.auth, `Bearer ${TOKEN}`)
    } finally {
      await p.close()
    }
  })

  test('logout and login revoke every token stored under any spelling of the platform', async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(p.base)
      const dir = tempDir('login-cwd')
      const both = {
        [p.base]: { store: 'file', token: 'bare-token', user: USER, signedInAt: SIGNED_IN },
        [`${p.base}/`]: {
          store: 'file',
          token: 'slashed-token',
          user: USER,
          signedInAt: SIGNED_IN,
        },
      }
      stored(m.file, both)
      p.live.add('bare-token').add('slashed-token')
      const who = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(p.seen.at(-1)?.auth, 'Bearer bare-token', 'the bare origin comes first')
      assert.equal(who.code, 0)

      const out = await runCli(dir, ['logout'], { env: m.env })
      assert.equal(out.code, 0, out.stdout + out.stderr)
      assert.ok(!p.live.has('bare-token'), 'the bare sign-in is revoked')
      assert.ok(!p.live.has('slashed-token'), 'the slashed sign-in is revoked')
      assert.ok(!existsSync(m.file))
      assert.ok(!(out.stdout + out.stderr).includes('-token'), 'no token is printed')

      stored(m.file, both)
      p.live.add('bare-token').add('slashed-token')
      const login = await runCli(dir, ['login'], { env: m.env })
      assert.equal(login.code, 0, login.stdout + login.stderr)
      assert.ok(!p.live.has('bare-token') && !p.live.has('slashed-token'), 'login revokes both')
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(m.file, 'utf8')).logins), [p.base])
    } finally {
      await p.close()
    }
  })

  test("another platform's sign-in (scheme, host or port) is kept and never sent", async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(p.base)
      const dir = tempDir('login-cwd')
      const port = Number(new URL(p.base).port)
      const others = {
        [`https://127.0.0.1:${port}/`]: 'scheme-token',
        [`http://localhost:${port}/`]: 'host-token',
        [`http://127.0.0.1:${port + 1}`]: 'port-token',
      }
      const logins = Object.fromEntries(
        Object.entries(others).map(([key, token]) => [
          key,
          { store: 'file', token, user: USER, signedInAt: SIGNED_IN },
        ]),
      )
      stored(m.file, logins)
      for (const token of Object.values(others)) p.live.add(token)
      const sent = () =>
        p.seen.filter((s) => Object.values(others).some((t) => s.auth?.includes(t)))

      const none = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(none.code, 2, none.stdout + none.stderr)
      assert.match(none.stderr, /Not signed in to /)
      assert.equal((await runCli(dir, ['login'], { env: m.env })).code, 0)
      assert.equal((await runCli(dir, ['whoami'], { env: m.env })).code, 0)
      assert.equal((await runCli(dir, ['logout'], { env: m.env })).code, 0)
      assert.deepEqual(sent(), [], "another platform's token is never sent")
      for (const token of Object.values(others)) assert.ok(p.live.has(token), `${token} stays live`)
      const kept = JSON.parse(readFileSync(m.file, 'utf8')).logins
      assert.deepEqual(Object.keys(kept).sort(), Object.keys(others).sort())
    } finally {
      await p.close()
    }
  })

  test('platformKey is the bare origin of any spelling of the URL', () => {
    for (const url of [
      'https://cloud.reeval.ai',
      'https://cloud.reeval.ai/',
      'HTTPS://Cloud.Reeval.AI:443/',
      'https://cloud.reeval.ai/some/path?q=1#x',
      new URL('https://cloud.reeval.ai/'),
    ]) {
      assert.equal(platformKey(url), 'https://cloud.reeval.ai', String(url))
    }
    assert.equal(platformKey('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787')
  })

  test('falls back to the file when the keychain refuses the token', async () => {
    const p = await platform({ pending: 0 })
    try {
      const bin = tempDir('login-bin')
      for (const tool of ['secret-tool', 'security']) {
        writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n')
        chmodSync(join(bin, tool), 0o755)
      }
      const m = machine(p.base, {
        REEVAL_NO_KEYCHAIN: '',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fake',
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      })
      const login = await runCli(tempDir('login-cwd'), ['login'], { env: m.env })
      assert.equal(login.code, 0, login.stdout + login.stderr)
      assert.match(login.stdout, /the token is in .*credentials\.json/)
      assert.equal(JSON.parse(readFileSync(m.file, 'utf8')).logins[p.base].token, TOKEN)
    } finally {
      await p.close()
    }
  })

  for (const [outcome, message] of [
    ['denied', /The sign-in was denied on the approval page/],
    ['expired', /The code expired before it was approved: run reeval login again/],
    ['refused', /the cloud platform refused the sign-in: This account can't sign in/],
  ] as const) {
    test(`exits 2 when the sign-in is ${outcome}, storing nothing`, async () => {
      const p = await platform({ outcome })
      try {
        const m = machine(p.base)
        const r = await runCli(tempDir('login-cwd'), ['login'], { env: m.env })
        assert.equal(r.code, 2, r.stdout + r.stderr)
        assert.match(r.stderr, message)
        assert.ok(!existsSync(m.file))
      } finally {
        await p.close()
      }
    })
  }

  test("refuses an approval page that isn't the platform's own", async () => {
    const p = await platform({ page: 'file:///etc/passwd' })
    try {
      const r = await runCli(tempDir('login-cwd'), ['login'], { env: machine(p.base).env })
      assert.equal(r.code, 3, r.stdout + r.stderr)
      assert.match(r.stderr, /sign-in page or code isn't one reeval opens/)
      assert.ok(!r.stdout.includes('/etc/passwd'))
    } finally {
      await p.close()
    }
  })

  test('REEVAL_TOKEN takes precedence over the stored sign-in', async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(p.base)
      const dir = tempDir('login-cwd')
      assert.equal((await runCli(dir, ['login'], { env: m.env })).code, 0)
      p.live.add('ci-token')
      const env = { ...m.env, REEVAL_TOKEN: 'ci-token' }
      const who = await runCli(dir, ['whoami'], { env })
      assert.equal(who.code, 0, who.stdout + who.stderr)
      assert.match(who.stdout, /\(token from REEVAL_TOKEN\)/)
      assert.equal(p.seen.at(-1)?.auth, 'Bearer ci-token')
      const bad = await runCli(dir, ['whoami'], { env: { ...m.env, REEVAL_TOKEN: 'wrong' } })
      assert.equal(bad.code, 2)
      assert.match(bad.stderr, /refused REEVAL_TOKEN: check it/)
      const out = await runCli(dir, ['logout'], { env })
      assert.equal(out.code, 0)
      assert.match(out.stderr, /REEVAL_TOKEN is still set: reeval logout doesn't change it/)
    } finally {
      await p.close()
    }
  })

  test('a sign-in the platform has revoked says to sign in again', async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(p.base)
      const dir = tempDir('login-cwd')
      assert.equal((await runCli(dir, ['login'], { env: m.env })).code, 0)
      p.live.clear()
      const who = await runCli(dir, ['whoami'], { env: m.env })
      assert.equal(who.code, 2)
      assert.match(who.stderr, /has expired or was revoked: reeval login signs in again/)
    } finally {
      await p.close()
    }
  })

  test("an unset REEVAL_CLOUD_URL is https://cloud.reeval.ai, and the project's .env overrides it", async () => {
    const p = await platform({ pending: 0 })
    try {
      const m = machine(p.base)
      delete m.env.REEVAL_CLOUD_URL
      const none = await runCli(tempDir('login-cwd'), ['logout'], { env: m.env })
      assert.equal(none.code, 0, none.stdout + none.stderr)
      assert.match(none.stdout, /Not signed in to https:\/\/cloud\.reeval\.ai with reeval login/)
      const bad = await runCli(tempDir('login-cwd'), ['login'], {
        env: { ...m.env, REEVAL_CLOUD_URL: 'ftp://platform.test' },
      })
      assert.equal(bad.code, 2)
      assert.match(
        bad.stderr,
        /REEVAL_CLOUD_URL is an http or https URL \(got ftp:\/\/platform\.test\)/,
      )
      const creds = await runCli(tempDir('login-cwd'), ['whoami'], {
        env: { ...m.env, REEVAL_CLOUD_URL: 'https://u:secret@platform.test' },
      })
      assert.equal(creds.code, 2)
      assert.match(creds.stderr, /can't carry a user name or password/)
      assert.ok(!creds.stderr.includes('secret@'))
      const dir = tempDir('login-project')
      writeFileSync(join(dir, '.env'), `REEVAL_CLOUD_URL=${p.base}\n`)
      const fromEnv = await runCli(dir, ['login'], { env: m.env })
      assert.equal(fromEnv.code, 0, fromEnv.stdout + fromEnv.stderr)
    } finally {
      await p.close()
    }
  })

  test('an unreachable platform exits 3, and a credentials file reeval cannot read exits 2', async () => {
    const p = await platform()
    const base = p.base
    await p.close()
    const m = machine(base)
    const r = await runCli(tempDir('login-cwd'), ['login'], { env: m.env })
    assert.equal(r.code, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /couldn't start signing in: .* didn't answer/)
    mkdirSync(join(m.config, 'reeval'), { recursive: true })
    writeFileSync(m.file, 'not json')
    const broken = await runCli(tempDir('login-cwd'), ['whoami'], { env: m.env })
    assert.equal(broken.code, 2)
    assert.match(broken.stderr, /credentials\.json isn't JSON: delete it/)
    writeFileSync(m.file, JSON.stringify({ schemaVersion: 2, logins: {} }))
    const newer = await runCli(tempDir('login-cwd'), ['whoami'], { env: m.env })
    assert.equal(newer.code, 2)
    assert.match(newer.stderr, /written by a newer reeval/)
  })
})
