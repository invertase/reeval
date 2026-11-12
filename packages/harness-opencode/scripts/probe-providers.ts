// Probes where the pinned OpenCode sends each provider's key: a MITM proxy answers every request
// itself (a 401), and `opencode run`, with reeval's config, goes through it once per provider and
// package, with a placeholder in each of the provider's variables. Nothing leaves the host.
//
//   node --experimental-strip-types scripts/probe-providers.ts <opencode> <catalog.json> <out.json> [ids...]
//
// <catalog.json> is models.dev's catalog (`https://models.opencode.ai/api.json`), for a model id
// per provider; the variables come from OpenCode's own `/api/integration`.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, TLSSocket } from 'node:tls'
import {
  createCertificateAuthority,
  issueServerCertificate,
} from '../../sandbox-docker/src/egress/cert.ts'
import { openCodeConfig } from '../src/opencode-harness.ts'
import { PROVIDER_VARS } from './provider-vars.ts'

const [opencode, catalogFile, outFile, ...only] = process.argv.slice(2)
if (!opencode || !catalogFile || !outFile) {
  throw new Error('usage: probe-providers.ts <opencode> <catalog.json> <out.json> [ids...]')
}
const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as Record<
  string,
  { api?: string; npm?: string; models: Record<string, { tool_call?: boolean }> }
>

type Seen = {
  method: string
  host: string
  path: string
  /** Where the placeholder was: a header's name, `query` or `body`. */
  key: string[]
  /** How the header carried it: `Bearer <key>`, or the key alone. */
  format?: 'bearer' | 'raw' | 'basic'
}
const seen = new Map<string, Seen[]>()
const PREFIX = 'esprobe'
const placeholderOf = (provider: string, variable: string) =>
  `${PREFIX}-${provider}-${variable}`.toLowerCase().replace(/[^a-z0-9-]/g, '')

function record(host: string, req: IncomingMessage, body: string) {
  const url = req.url ?? '/'
  const path = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0]
  const hits = new Map<string, { where: string; format?: Seen['format'] }[]>()
  const note = (text: string, where: string, format?: Seen['format']) => {
    for (const m of text.matchAll(new RegExp(`${PREFIX}-([a-z0-9-]+)`, 'g'))) {
      const provider = m[1]?.split('-').slice(0, -1).join('-') ?? ''
      const list = hits.get(provider) ?? []
      list.push({ where, ...(format ? { format } : {}) })
      hits.set(provider, list)
    }
  }
  for (const [name, value] of Object.entries(req.headers)) {
    const v = String(value)
    const format = /^bearer\s/i.test(v)
      ? 'bearer'
      : /^basic\s/i.test(v)
        ? 'basic'
        : v.toLowerCase().startsWith(PREFIX)
          ? 'raw'
          : undefined
    note(v.toLowerCase(), name, format)
    if (format === 'basic')
      note(Buffer.from(v.slice(6), 'base64').toString().toLowerCase(), name, format)
  }
  note(url.includes('?') ? url.slice(url.indexOf('?')).toLowerCase() : '', 'query')
  note(body.toLowerCase(), 'body')
  const entry = (key: string[], format?: Seen['format']): Seen => ({
    method: req.method ?? 'GET',
    host,
    path: path.replace(new RegExp(`${PREFIX}-[a-z0-9-]+`, 'gi'), '<key>'),
    key,
    ...(format ? { format } : {}),
  })
  const owner = [...hits.keys()][0]
  if (!owner) {
    const list = seen.get('(no key)') ?? []
    list.push(entry([]))
    seen.set('(no key)', list)
    return
  }
  for (const [provider, where] of hits) {
    const list = seen.get(provider) ?? []
    list.push(entry([...new Set(where.map((w) => w.where))], where.find((w) => w.format)?.format))
    seen.set(provider, list)
  }
}

function answer(host: string, req: IncomingMessage, res: ServerResponse) {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    record(host, req, body)
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({ error: { message: 'reeval provider probe', type: 'invalid_api_key' } }),
    )
  })
}

const ca = createCertificateAuthority(1)
const dir = mkdtempSync(join(tmpdir(), 'reeval-oc-probe-'))
const caFile = join(dir, 'ca.pem')
writeFileSync(caFile, ca.cert)
const contexts = new Map<string, ReturnType<typeof createSecureContext>>()
const contextFor = (host: string) => {
  let ctx = contexts.get(host)
  if (!ctx) {
    const leaf = issueServerCertificate(ca, host)
    ctx = createSecureContext({
      cert: leaf.cert,
      key: leaf.key.export({ type: 'pkcs8', format: 'pem' }),
    })
    contexts.set(host, ctx)
  }
  return ctx
}

const inner = createServer((req, res) => {
  const host =
    (req.socket as TLSSocket & { reevalHost?: string }).reevalHost ?? req.headers.host ?? ''
  answer(host.split(':')[0] ?? host, req, res)
})
const proxy = createServer((req, res) => answer(new URL(req.url ?? '').hostname, req, res))
proxy.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
  const host = (req.url ?? '').split(':')[0] ?? ''
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head.length) socket.unshift(head)
  const tls = new TLSSocket(socket, {
    isServer: true,
    ALPNProtocols: ['http/1.1'],
    SNICallback: (name, cb) => cb(null, contextFor(name)),
    secureContext: contextFor(host),
  }) as TLSSocket & { reevalHost?: string }
  tls.reevalHost = host
  tls.on('error', (e) => process.stderr.write(`tls ${host} ${e.message}\n`))
  inner.emit('connection', tls)
})
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const port = (proxy.address() as { port: number }).port

type Integration = { id: string; name: string; methods: { type: string; names?: string[] }[] }

/**
 * OpenCode's integrations, from a private `opencode serve`. `/api/integration` answers with the
 * ones loaded so far, and plugins add the providers' as they load, so it's asked only once
 * `/api/provider`, which waits for the plugins, has answered: one server for both requests.
 */
async function integrations(): Promise<Integration[]> {
  const home = mkdtempSync(join(dir, 'home-'))
  const password = 'reeval-probe'
  const child = spawn(opencode as string, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    env: {
      PATH: process.env.PATH ?? '',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_SERVER_PASSWORD: password,
      HOME: home,
    },
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      const timer = setTimeout(
        () => reject(new Error(`opencode serve didn't start: ${out}`)),
        30_000,
      )
      const listen = (c: Buffer) => {
        out += c
        const m = /server listening on (http:\/\/\S+)/.exec(out)
        if (m?.[1]) {
          clearTimeout(timer)
          resolve(m[1])
        }
      }
      child.stdout.on('data', listen)
      child.stderr.on('data', listen)
      child.on('exit', (code) => reject(new Error(`opencode serve exited ${code}: ${out}`)))
    })
    const get = async (path: string) => {
      const res = await fetch(`${url}${path}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`opencode serve: GET ${path}: HTTP ${res.status}`)
      return res.json() as Promise<{ data: Integration[] }>
    }
    await get('/api/provider')
    const { data } = await get('/api/integration')
    if (!data.length) throw new Error('opencode serve listed no integrations')
    return data
  } finally {
    child.kill('SIGKILL')
  }
}

function run(args: string[], env: Record<string, string>, timeout: number) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(opencode as string, args, {
      env: {
        PATH: process.env.PATH ?? '',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        ...env,
      },
      cwd: env.HOME,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

type CatalogModel = {
  tool_call?: boolean
  release_date?: string
  provider?: { npm?: string; api?: string }
}

/**
 * The provider's models by the package and base URL they run on (a model can override its
 * provider's), newest first: one probe per variant, since each can send the key differently.
 */
function variants(id: string) {
  const provider = catalog[id]
  const groups = new Map<string, string[]>()
  const models = Object.entries(provider?.models ?? {}) as [string, CatalogModel][]
  models.sort(([, a], [, b]) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
  for (const [model, m] of models) {
    if (!m.tool_call) continue
    const key = `${m.provider?.npm ?? provider?.npm ?? ''} ${m.provider?.api ?? provider?.api ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), model])
  }
  return [...groups].map(([key, list]) => ({ key, models: list }))
}

const clean = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colors
  text.replace(/\u001b\[[0-9;]*m/g, '').trim()

const all = await integrations()
const targets = all.filter((i) => (only.length ? only.includes(i.id) : true))
const results: Record<string, unknown> = {}
const queue = [...targets]
const normal = (id: string) => id.toLowerCase().replace(/[^a-z0-9-]/g, '')
async function worker() {
  for (let i = queue.shift(); i; i = queue.shift()) {
    const names = i.methods.flatMap((m) => (m.type === 'env' ? (m.names ?? []) : []))
    const groups = variants(i.id)
    if (!names.length || !groups.length) {
      results[i.id] = {
        name: i.name,
        skipped: !names.length ? 'no env method' : 'no tool model in the catalog',
      }
      continue
    }
    const probe = async (variant: string, model: string, extra: Record<string, string> = {}) => {
      const home = mkdtempSync(join(dir, `home-${i.id}-`))
      mkdirSync(join(home, 'w'))
      const env: Record<string, string> = {
        HOME: home,
        HTTPS_PROXY: `http://127.0.0.1:${port}`,
        HTTP_PROXY: `http://127.0.0.1:${port}`,
        NO_PROXY: '127.0.0.1,localhost',
        NODE_EXTRA_CA_CERTS: caFile,
        SSL_CERT_FILE: caFile,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig({ model: `${i.id}/${model}` })),
        ...extra,
      }
      for (const n of names) env[n] = placeholderOf(i.id, n)
      for (const v of PROVIDER_VARS[i.id] ?? []) env[v.name] = v.probe
      const before = seen.get(normal(i.id))?.length ?? 0
      const out = await run(
        ['run', '--standalone', '-m', `${i.id}/${model}`, 'Say hi.'],
        env,
        30_000,
      )
      const error = clean(out.stderr).slice(-300)
      return {
        variant,
        model,
        exit: out.code,
        error,
        requests: (seen.get(normal(i.id)) ?? []).slice(before),
      }
    }
    const probed = []
    for (const group of groups) {
      let last: Awaited<ReturnType<typeof probe>> | undefined
      for (const model of group.models.slice(0, 12)) {
        last = await probe(group.key, model)
        if (!/Model unavailable/.test(last.error)) break
      }
      // OpenCode knows only the models in the catalog built into its release, and models.dev
      // renames a provider's models now and then: when it knows none of these, the newest one
      // runs on the catalog they came from, so what's probed is still where the key goes.
      if (last && /Model unavailable/.test(last.error)) {
        last = await probe(group.key, group.models[0] as string, {
          OPENCODE_MODELS_PATH: catalogFile,
        })
      }
      probed.push(last)
      // A gateway can run each upstream's models on its own API (OpenCode sends Vercel AI
      // Gateway's `openai/` models to /v1/responses and `anthropic/` ones to /v1/messages), so the
      // newest model of every other upstream runs too, and only where its key went is kept.
      const upstream = (model: string) => (model.includes('/') ? model.split('/')[0] : undefined)
      const others = new Map<string, string>()
      for (const model of group.models) {
        const u = upstream(model)
        if (u && u !== upstream(last?.model ?? '') && !others.has(u)) others.set(u, model)
      }
      for (const model of others.values()) {
        let also = await probe(group.key, model)
        if (/Model unavailable/.test(also.error)) {
          also = await probe(group.key, model, { OPENCODE_MODELS_PATH: catalogFile })
        }
        if (also.requests.length) probed.push({ ...also, also: true })
      }
    }
    results[i.id] = { name: i.name, env: names, variants: probed }
    process.stderr.write(`${i.id} ${probed.map((p) => p.exit).join(',')}\n`)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))
results['(no key)'] = seen.get('(no key)') ?? []
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`)
proxy.close()
process.exit(0)
