// `reeval link` against a fake platform that lists orgs and projects as the platform's routes do:
// the prompts on a terminal, the flags without one, and the link the cloud commands then read.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, test } from 'node:test'
import type { Flags } from '../src/cli-spec.ts'
import { linkCommand } from '../src/link.ts'
import { runCli, tempDir } from './helpers.ts'

const TOKEN = 'link-session-token'
const ACME = { id: 'org_acme', slug: 'acme', name: 'Acme', role: 'owner' }
const LAB = { id: 'org_lab', slug: 'lab', name: 'Lab', role: 'member' }
const project = (orgId: string, slug: string, name: string) => ({
  id: `proj_${slug}`,
  orgId,
  slug,
  name,
  createdAt: '2026-11-10T12:00:00.000Z',
})
const PROJECTS: Record<string, ReturnType<typeof project>[]> = {
  org_acme: [project('org_acme', 'api', 'API'), project('org_acme', 'web', 'Web app')],
  org_lab: [project('org_lab', 'evals', 'Evals')],
}

async function platform(options: { orgs?: (typeof ACME)[]; projects?: typeof PROJECTS } = {}) {
  const seen: string[] = []
  const orgs = options.orgs ?? [ACME, LAB]
  const projects = options.projects ?? PROJECTS
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const fail = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message, retryable: false } })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://platform')
    seen.push(`${req.method} ${url.pathname}`)
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return fail(res, 401, 'unauthorized', 'Sign in first.')
    }
    if (req.method === 'GET' && url.pathname === '/api/orgs') return json(res, 200, { orgs })
    const p = /^\/api\/orgs\/([^/]+)\/projects$/.exec(url.pathname)
    if (req.method === 'GET' && p) {
      const org = decodeURIComponent(p[1] ?? '')
      if (!orgs.some((o) => o.id === org)) return fail(res, 404, 'not_found', `No org ${org}.`)
      return json(res, 200, { projects: projects[org] ?? [] })
    }
    const s = /^\/api\/orgs\/([^/]+)\/projects\/([^/]+)\/secrets$/.exec(url.pathname)
    if (req.method === 'GET' && s) return json(res, 200, { secrets: [] })
    fail(res, 404, 'not_found', `no route ${url.pathname}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    seen,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const env = (base: string, token: string | null = TOKEN) =>
  ({
    REEVAL_CLOUD_URL: base,
    ...(token && { REEVAL_TOKEN: token }),
    XDG_CONFIG_HOME: tempDir('link-config'),
    REEVAL_NO_KEYCHAIN: '1',
  }) as NodeJS.ProcessEnv

/** `reeval link` with `answers` typed on a terminal, or none and no terminal. */
async function link(
  base: string,
  dir: string,
  flags: Flags,
  answers?: string[],
  e: NodeJS.ProcessEnv = env(base),
) {
  const output = new PassThrough()
  let asked = ''
  output.on('data', (c) => {
    asked += c
  })
  const out: string[] = []
  const run = linkCommand(flags, {
    out: (line) => out.push(line),
    input: Readable.from(answers ? [answers.map((a) => `${a}\n`).join('')] : []),
    output,
    interactive: answers !== undefined,
    projectDir: dir,
    cwd: dir,
    env: e,
  })
  return run.then(
    (code) => ({ code, asked, out: out.join('\n'), error: undefined as Error | undefined }),
    (error: Error) => ({ code: undefined, asked, out: out.join('\n'), error }),
  )
}

const linkFile = (dir: string) => join(dir, '.reeval/project.json')
const linked = (dir: string) => JSON.parse(readFileSync(linkFile(dir), 'utf8'))

describe('reeval link on a terminal', () => {
  test('asks for the org and the project and writes their ids to .reeval/project.json', async () => {
    const p = await platform()
    try {
      const dir = tempDir('link')
      const r = await link(p.base, dir, {}, ['1', 'web'])
      assert.equal(r.code, 0, r.error?.message)
      assert.match(r.asked, /Which org\?\n {2}1\) Acme \(acme\)\n {2}2\) Lab \(lab\)\nOrg \[1\]: /)
      assert.match(r.asked, /Which project\?\n {2}1\) API \(api\)\n {2}2\) Web app \(web\)\n/)
      assert.equal(
        r.out,
        'Linked this project to Web app (web) in Acme (acme): wrote .reeval/project.json.',
      )
      assert.deepEqual(linked(dir), { orgId: 'org_acme', projectId: 'proj_web' })
      assert.deepEqual(p.seen, ['GET /api/orgs', 'GET /api/orgs/org_acme/projects'])
    } finally {
      await p.close()
    }
  })

  test("doesn't ask for the org when there's one, and asks again after an answer that isn't one", async () => {
    const p = await platform({ orgs: [LAB] })
    try {
      const dir = tempDir('link')
      const r = await link(p.base, dir, {}, ['7', ''])
      assert.equal(r.code, 0, r.error?.message)
      assert.doesNotMatch(r.asked, /Which org/)
      assert.match(r.asked, /Project \[1\]: Answer 1 to 1, or a slug\.\nProject \[1\]: $/)
      assert.deepEqual(linked(dir), { orgId: 'org_lab', projectId: 'proj_evals' })
    } finally {
      await p.close()
    }
  })

  test('asks before replacing a link, and keeps it on no', async () => {
    const p = await platform()
    try {
      const dir = tempDir('link')
      mkdirSync(join(dir, '.reeval'))
      const before = '{"orgId":"org_lab","projectId":"proj_evals"}'
      writeFileSync(linkFile(dir), before)
      const no = await link(p.base, dir, {}, ['n'])
      assert.equal(no.code, 0, no.error?.message)
      assert.match(
        no.asked,
        /^\.reeval\/project\.json links this project to Evals \(evals\) in Lab \(lab\)\. Replace it\? \[y\/N\] $/,
      )
      assert.equal(no.out, 'Kept .reeval/project.json.')
      assert.equal(readFileSync(linkFile(dir), 'utf8'), before)
      const yes = await link(p.base, dir, {}, ['y', '1', '1'])
      assert.equal(yes.code, 0, yes.error?.message)
      assert.deepEqual(linked(dir), { orgId: 'org_acme', projectId: 'proj_api' })
    } finally {
      await p.close()
    }
  })

  test('a link file reeval cannot read is replaced the same way', async () => {
    const p = await platform({ orgs: [LAB] })
    try {
      const dir = tempDir('link')
      mkdirSync(join(dir, '.reeval'))
      writeFileSync(linkFile(dir), '{"orgId":')
      const r = await link(p.base, dir, {}, ['yes', 'evals'])
      assert.equal(r.code, 0, r.error?.message)
      assert.match(r.asked, /^\.reeval\/project\.json isn't a link reeval reads\. Replace it\?/)
      assert.deepEqual(linked(dir), { orgId: 'org_lab', projectId: 'proj_evals' })
    } finally {
      await p.close()
    }
  })

  test('input that ends before an answer is a usage error, and writes nothing', async () => {
    const p = await platform()
    try {
      const dir = tempDir('link')
      const r = await link(p.base, dir, {}, ['2'])
      assert.match(r.error?.message ?? '', /got no answer\. Pass --org, --project and --yes/)
      assert.ok(!existsSync(linkFile(dir)))
    } finally {
      await p.close()
    }
  })
})

describe('reeval link without a terminal', () => {
  test('--org and --project take a slug or an id; the same link again changes nothing', async () => {
    const p = await platform()
    try {
      const dir = tempDir('link')
      const r = await link(p.base, dir, { org: 'acme', project: 'proj_web' })
      assert.equal(r.code, 0, r.error?.message)
      assert.deepEqual(linked(dir), { orgId: 'org_acme', projectId: 'proj_web' })
      const again = await link(p.base, dir, { org: 'org_acme', project: 'WEB' })
      assert.equal(again.code, 0, again.error?.message)
      assert.equal(
        again.out,
        '.reeval/project.json links this project to Web app (web) in Acme (acme) already.',
      )
    } finally {
      await p.close()
    }
  })

  test('refuses to replace another link without --yes, and replaces it with it', async () => {
    const p = await platform()
    try {
      const dir = tempDir('link')
      await link(p.base, dir, { org: 'acme', project: 'web' })
      const refused = await link(p.base, dir, { org: 'lab', project: 'evals' })
      assert.match(
        refused.error?.message ?? '',
        /^\.reeval\/project\.json links this project to Web app \(web\) in Acme \(acme\): pass --yes to replace it\.$/,
      )
      assert.deepEqual(linked(dir), { orgId: 'org_acme', projectId: 'proj_web' })
      const r = await link(p.base, dir, { org: 'lab', project: 'evals', yes: true })
      assert.equal(r.code, 0, r.error?.message)
      assert.deepEqual(linked(dir), { orgId: 'org_lab', projectId: 'proj_evals' })
    } finally {
      await p.close()
    }
  })

  test('names the flag and the choices it needs, and an org or project that is not there', async () => {
    const p = await platform()
    try {
      const dir = tempDir('link')
      const cases: [Flags, RegExp][] = [
        [{}, /You're in 2 orgs .* pass --org with one of acme, lab$/],
        [
          { org: 'acme' },
          /which project in Acme \(acme\) to link: pass --project with one of api, web$/,
        ],
        [{ org: 'nope', project: 'web' }, /has no org nope: pass --org with one of acme, lab$/],
        [
          { org: 'acme', project: 'evals' },
          /^Acme \(acme\) has no project evals: pass --project with one of api, web$/,
        ],
        [{ org: '' }, /^--org needs a value/],
        [{ project: '' }, /^--project needs a value/],
      ]
      for (const [flags, message] of cases) {
        const r = await link(p.base, dir, flags)
        assert.match(r.error?.message ?? '', message, JSON.stringify(flags))
      }
      assert.ok(!existsSync(linkFile(dir)))
    } finally {
      await p.close()
    }
  })

  test('an org with no projects, or no org at all, says so', async () => {
    const p = await platform({ orgs: [ACME], projects: {} })
    try {
      const r = await link(p.base, tempDir('link'), { project: 'web' })
      assert.match(r.error?.message ?? '', /^Acme \(acme\) has no projects yet: create one on http/)
    } finally {
      await p.close()
    }
    const none = await platform({ orgs: [] })
    try {
      const r = await link(none.base, tempDir('link'), {})
      assert.match(r.error?.message ?? '', /^You aren't in any org on http/)
    } finally {
      await none.close()
    }
  })
})

describe('reeval link and a platform that does not answer as one', () => {
  test('a page that is not a list of orgs is the platform failing, not an empty org list', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>app</html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const r = await link(base, tempDir('link'), {}, [], env(base))
      assert.equal(r.error?.name, 'CloudError')
      assert.match(r.error?.message ?? '', /^the cloud platform didn't list your orgs$/)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('reeval link and the sign-in', () => {
  test('signed out, says to run reeval login first and asks the platform nothing', async () => {
    const p = await platform()
    try {
      const r = await link(p.base, tempDir('link'), {}, [], env(p.base, null))
      assert.match(
        r.error?.message ?? '',
        /^Not signed in to http:\/\/127\.0\.0\.1:\d+: run reeval login first, or set REEVAL_TOKEN\.$/,
      )
      assert.deepEqual(p.seen, [])
    } finally {
      await p.close()
    }
  })

  test('a refused sign-in says to log in again; a refused REEVAL_TOKEN says to check it', async () => {
    const p = await platform()
    try {
      const config = tempDir('link-login')
      mkdirSync(join(config, 'reeval'))
      writeFileSync(
        join(config, 'reeval/credentials.json'),
        JSON.stringify({
          schemaVersion: 1,
          logins: {
            [`${p.base}/`]: {
              store: 'file',
              token: 'expired-token',
              user: { email: 'ada@example.com' },
              signedInAt: new Date().toISOString(),
            },
          },
        }),
      )
      const stored = { ...env(p.base, null), XDG_CONFIG_HOME: config }
      const r = await link(p.base, tempDir('link'), {}, [], stored)
      assert.match(r.error?.message ?? '', /has expired or was revoked: run reeval login again\.$/)
      const bad = await link(p.base, tempDir('link'), {}, [], env(p.base, 'wrong'))
      assert.match(bad.error?.message ?? '', /refused REEVAL_TOKEN: check it\.$/)
    } finally {
      await p.close()
    }
  })
})

describe('reeval link from the CLI', () => {
  test('writes the link beside the config, where reeval cloud secrets reads it', async () => {
    const p = await platform()
    try {
      const dir = tempDir('link-cli')
      writeFileSync(join(dir, 'reeval.config.ts'), 'export default {}\n')
      mkdirSync(join(dir, 'evals'))
      const e = env(p.base)
      const asked = await runCli(join(dir, 'evals'), ['link'], { env: e })
      assert.equal(asked.code, 2, asked.stdout + asked.stderr)
      assert.match(asked.stderr, /pass --org with one of acme, lab/)
      const r = await runCli(join(dir, 'evals'), ['link', '--org', 'acme', '--project', 'web'], {
        env: e,
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(
        r.stdout,
        /Linked this project to Web app \(web\) in Acme \(acme\): wrote \.\.\/\.reeval\/project\.json\./,
      )
      assert.deepEqual(linked(dir), { orgId: 'org_acme', projectId: 'proj_web' })
      const list = await runCli(dir, ['cloud', 'secrets', 'list'], { env: e })
      assert.equal(list.code, 0, list.stdout + list.stderr)
      assert.equal(p.seen.at(-1), 'GET /api/orgs/org_acme/projects/proj_web/secrets')
    } finally {
      await p.close()
    }
  })
})
