// Runs inside a sandbox with the pinned pi installed (the `pi` image): for each provider pi reads a
// key for, sends one prompt to a local server standing in for each of the provider's APIs, and
// prints, as JSON, the requests that carried the key and how, and the providers it reads no key
// for. provider-table.mjs runs it.
//
// node probe.mjs <bootstrap dir>
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const [bootstrapDir] = process.argv.slice(2)
const agent = realpathSync(join(bootstrapDir, 'node_modules/@earendil-works/pi-coding-agent'))
const ai = join(dirname(agent), 'pi-ai/dist')
const cli = join(bootstrapDir, 'node_modules/.bin/pi')

// pi-ai's provider → key variable map, as env-api-keys.js spells it.
const source = readFileSync(join(ai, 'env-api-keys.js'), 'utf8')
const map = source.slice(
  source.indexOf('const envMap = {'),
  source.indexOf('};', source.indexOf('const envMap = {')),
)
const keys = Object.fromEntries(
  [...map.matchAll(/^\s*"?([\w-]+)"?: "(\w+)",$/gm)].map(([, provider, env]) => [provider, env]),
)
keys.anthropic = 'ANTHROPIC_API_KEY'

const PLACEHOLDER = 'reeval_probe_key'
const seen = []
const server = createServer((req, res) => {
  const headers = Object.entries(req.headers).flatMap(([name, value]) => {
    const v = String(value)
    if (!v.includes(PLACEHOLDER)) return []
    return [
      { name, scheme: v === PLACEHOLDER ? undefined : v.slice(0, v.indexOf(PLACEHOLDER)).trim() },
    ]
  })
  seen.push({ method: req.method, url: req.url, headers })
  req.resume()
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end('{"error":{"message":"probe"}}')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const { port } = server.address()

const chat = (provider) => {
  try {
    const data = JSON.parse(readFileSync(join(ai, `providers/data/${provider}.json`), 'utf8'))
    return Object.values(data).flatMap((models) =>
      Object.entries(models).flatMap(([key, m]) => (key.startsWith('chat:') ? [m] : [])),
    )
  } catch {
    return []
  }
}

/** One pi turn on `provider`'s `model`, with the placeholder as its key; its output. */
function run(provider, model, env) {
  const args = ['--mode', 'json', '-p', '--offline', '--no-extensions']
  const child = spawn(cli, [...args, '--provider', provider, '--model', model, 'hi'], {
    env: { PATH: process.env.PATH, HOME: homedir(), PI_OFFLINE: '1', [env]: PLACEHOLDER },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => {
    output += d
  })
  child.stderr.on('data', (d) => {
    output += d
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  return new Promise((done) =>
    child.on('close', () => {
      clearTimeout(timer)
      done(output)
    }),
  )
}

const modelsFile = join(homedir(), '.pi/agent/models.json')
const results = []
for (const [provider, env] of Object.entries(keys)) {
  const groups = new Map()
  for (const m of chat(provider)) {
    const key = `${m.api} ${m.baseUrl}`
    if (!groups.has(key)) groups.set(key, m)
  }
  const apis = []
  for (const m of groups.values()) {
    const entry = { api: m.api, baseUrl: m.baseUrl, model: m.id, requests: [] }
    apis.push(entry)
    let url
    try {
      url = new URL(m.baseUrl)
    } catch {
      continue
    }
    if (/[{}$]/.test(m.baseUrl)) continue
    mkdirSync(dirname(modelsFile), { recursive: true })
    writeFileSync(
      modelsFile,
      JSON.stringify({
        providers: {
          [provider]: { baseUrl: `http://127.0.0.1:${port}${url.pathname.replace(/\/$/, '')}` },
        },
      }),
    )
    seen.length = 0
    const output = await run(provider, m.id, env)
    entry.requests = seen.splice(0)
    if (!entry.requests.length) entry.output = output.slice(-400)
  }
  results.push({ provider, env, apis })
}
for (const file of readdirSync(join(ai, 'providers/data'))) {
  const provider = file.replace(/\.json$/, '')
  if (file.endsWith('.json') && !file.startsWith('.') && !keys[provider]) {
    results.push({ provider, apis: [] })
  }
}
rmSync(modelsFile, { force: true })
server.close()
const { version } = JSON.parse(readFileSync(join(ai, '../package.json'), 'utf8'))
process.stdout.write(`${JSON.stringify({ piAi: version, providers: results }, null, 2)}\n`)
