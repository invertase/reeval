// A fake Boat API for tests: the routes of `@boatdev/sdk` that reeval calls (create, get, sshkey,
// list by name prefix, delete and limits) on 127.0.0.1, with Boat's own shapes and quirks: a
// sandbox reports `starting` before `ready`, a delete needs `X-Ascii-Confirm-Delete`, and every
// call needs the key as a bearer token. Where its sandboxes run is up to `machines`: a container
// laid out like a Boat VM (`dockerMachines`), or an address nothing listens on
// (`unreachableMachines`), for the lifecycle without Docker. `boatSandboxesLeft` asks the real
// one, for the contract's rows in boat().
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { NODE_IMAGE } from '../../../sandbox-docker/src/build-image.ts'
import { boatClient, runPrefix } from '../../src/sandbox/boat.ts'
import { boat } from '../../src/sandbox-boat.ts'

/** Where one fake sandbox's SSH server is, and how to let a key in. */
export type FakeMachine = {
  /** `host:port`, as Boat's `sshEndpoint`. */
  endpoint: string
  user: string
  /** `<type> <base64>`, as Boat's `hostKey`. */
  hostKey: string
  authorize(publicKey: string): Promise<void>
  remove(): Promise<void>
}

export type Machines = (name: string) => Promise<FakeMachine>

type FakeSandbox = {
  id: string
  name: string
  type: string
  state: 'starting' | 'ready' | 'error'
  error?: string
  ttlSeconds: number
  machine: Promise<FakeMachine>
  /** `get` calls answered, so the first says `starting`. */
  polls: number
}

export type FakeBoat = {
  /** BOAT_BASE_URL for reeval. */
  url: string
  key: string
  /** The sandboxes that exist now, by name. */
  live(): string[]
  /** Every call, as `METHOD /path`, with what reeval sent that a check reads. */
  requests: Array<{ call: string; idempotencyKey?: string; body?: Record<string, unknown> }>
  close(): Promise<void>
}

const json = (status: number, body: unknown) => ({ status, body })

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

export async function fakeBoat(
  machines: Machines,
  options: { key?: string; maxActive?: number } = {},
): Promise<FakeBoat> {
  const key = options.key ?? `boat_test_${randomBytes(8).toString('hex')}`
  const sandboxes = new Map<string, FakeSandbox>()
  const requests: FakeBoat['requests'] = []
  const view = (s: FakeSandbox) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    state: s.state,
    ttlSeconds: s.ttlSeconds,
    ...(s.error && { error: s.error }),
  })
  const handle = async (req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const method = req.method ?? 'GET'
    const body = method === 'POST' ? await bodyOf(req) : undefined
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined
    requests.push({
      call: `${method} ${path}`,
      ...(idempotencyKey && { idempotencyKey }),
      ...(body && { body }),
    })
    if (req.headers.authorization !== `Bearer ${key}`) {
      return json(401, { error: { code: 'unauthorized', message: 'invalid API key' } })
    }
    const [, collection, id, sub] = path.split('/')
    if (collection === 'limits' && method === 'GET') {
      return json(200, {
        canStart: true,
        activeSandboxes: sandboxes.size,
        maxActiveSandboxes: options.maxActive ?? 10,
        machineTypes: [
          { type: 'small', available: true, reason: null },
          { type: 'large', available: false, reason: 'not on this plan' },
        ],
      })
    }
    if (collection !== 'sandboxes') return json(404, { error: { code: 'not_found' } })
    if (!id && method === 'POST') {
      const request = body as { name: string; type?: string; ttlSeconds?: number }
      const existing = [...sandboxes.values()].find((s) => s.name === request.name)
      if (existing) return json(200, { ok: true, sandbox: view(existing) })
      const sandbox: FakeSandbox = {
        id: `bx_${randomBytes(4).toString('hex')}`,
        name: request.name,
        type: request.type ?? 'small',
        state: 'starting',
        ttlSeconds: request.ttlSeconds ?? 3600,
        machine: machines(request.name),
        polls: 0,
      }
      sandbox.machine.then(
        () => {
          sandbox.state = 'ready'
        },
        (error: Error) => {
          sandbox.state = 'error'
          sandbox.error = error.message
        },
      )
      sandboxes.set(sandbox.id, sandbox)
      return json(201, { ok: true, type: sandbox.type, status: 'starting', sandbox: view(sandbox) })
    }
    if (!id && method === 'GET') {
      const prefix = url.searchParams.get('namePrefix') ?? ''
      const list = [...sandboxes.values()].filter((s) => s.name.startsWith(prefix)).map(view)
      return json(200, { sandboxes: list, pageInfo: { nextCursor: null, hasMore: false } })
    }
    const sandbox = sandboxes.get(id ?? '')
    if (!sandbox) return json(404, { error: { code: 'not_found', message: `no sandbox ${id}` } })
    if (!sub && method === 'GET') {
      if (sandbox.polls++ === 0)
        return json(200, { sandbox: { ...view(sandbox), state: 'starting' } })
      return json(200, { sandbox: view(sandbox) })
    }
    if (sub === 'sshkey' && method === 'POST') {
      const machine = await sandbox.machine
      await machine.authorize(String((body as { key?: string }).key))
      return json(200, {
        sshUser: machine.user,
        sshEndpoint: machine.endpoint,
        hostKey: machine.hostKey,
      })
    }
    if (!sub && method === 'DELETE') {
      if (req.headers['x-ascii-confirm-delete'] !== sandbox.id) {
        return json(400, {
          error: {
            code: 'confirm_required',
            message: 'X-Ascii-Confirm-Delete must be the sandbox id',
          },
        })
      }
      sandboxes.delete(sandbox.id)
      await (await sandbox.machine.catch(() => null))?.remove()
      return json(200, { ok: true })
    }
    return json(404, { error: { code: 'not_found' } })
  }
  const server: Server = createServer((req, res) => {
    handle(req).then(
      ({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      },
      (error: Error) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'internal', message: error.message } }))
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    key,
    live: () => [...sandboxes.values()].map((s) => s.name),
    requests,
    async close() {
      await Promise.all(
        [...sandboxes.values()].map(async (s) => (await s.machine.catch(() => null))?.remove()),
      )
      sandboxes.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Machines whose SSH endpoint nothing listens on: Boat's side of the lifecycle, without a VM. */
export const unreachableMachines: Machines = async () => ({
  endpoint: '127.0.0.1:1',
  user: 'user',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOkVnNvZ8lfy5H2wK0ljJm0cz6dJ7l4LwW8kQx2bH9oD',
  authorize: async () => {},
  remove: async () => {},
})

/**
 * A Boat VM's layout where it matters to reeval: a login user `user` with passwordless sudo, sshd,
 * git, and a Node whose `/usr/local/bin/node` links into that user's nvm, under a home others can't
 * enter. No `reeval` user: the session makes it.
 */
const BOAT_VM_DOCKERFILE = `FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server sudo curl git procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash user \\
 && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \\
 && mkdir -p /home/user/.nvm/versions/node/current/bin /home/user/.ssh /run/sshd \\
 && mv /usr/local/bin/node /home/user/.nvm/versions/node/current/bin/node \\
 && ln -s /home/user/.nvm/versions/node/current/bin/node /usr/local/bin/node \\
 && chown -R user:user /home/user && chmod 750 /home/user && chmod 700 /home/user/.ssh \\
 && ssh-keygen -A
CMD ["/usr/sbin/sshd", "-D", "-e"]
`

/** The fake Boat VM image's tag, which changes with its Dockerfile. */
export const BOAT_VM_IMAGE = `reeval-fake-boat-vm:${createHash('sha256').update(BOAT_VM_DOCKERFILE).digest('hex').slice(0, 12)}`
/** The label on every fake Boat VM container, for a sweep. */
export const BOAT_VM_LABEL = 'reeval.test.fake-boat'

/** Builds the fake Boat VM image unless it's there. */
export function buildBoatVmImage(): void {
  try {
    execFileSync('docker', ['image', 'inspect', BOAT_VM_IMAGE], { stdio: 'ignore' })
    return
  } catch {}
  execFileSync('docker', ['build', '-q', '-t', BOAT_VM_IMAGE, '-'], {
    input: BOAT_VM_DOCKERFILE,
    stdio: ['pipe', 'ignore', 'inherit'],
  })
}

const docker = (args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`docker ${args[0]}: ${err.trim()}`)),
    )
    child.stdin.end(input ?? '')
  })

/** Until `port` on 127.0.0.1 greets with an SSH banner. */
async function sshUp(port: number, deadline = Date.now() + 30_000): Promise<void> {
  for (;;) {
    const banner = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.setTimeout(2000)
      socket.once('data', (d) => {
        resolve(String(d))
        socket.destroy()
      })
      // Docker's port proxy accepts, then closes, until sshd listens.
      socket.once('close', () => resolve(''))
      socket.once('error', () => resolve(''))
      socket.once('timeout', () => {
        resolve('')
        socket.destroy()
      })
    })
    if (banner.startsWith('SSH-')) return
    if (Date.now() > deadline) throw new Error(`the fake Boat VM's sshd never answered on ${port}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Each sandbox a container of {@link BOAT_VM_IMAGE}, its sshd on a port of 127.0.0.1. */
export const dockerMachines: Machines = async (name) => {
  const id = await docker([
    'run',
    '-d',
    '--rm',
    '--label',
    `${BOAT_VM_LABEL}=${name}`,
    '-p',
    '127.0.0.1::22',
    BOAT_VM_IMAGE,
  ])
  const remove = async () => {
    await docker(['rm', '-f', id]).catch(() => {})
  }
  try {
    const mapped = await docker(['port', id, '22/tcp'])
    const port = Number(/:(\d+)\s*$/m.exec(mapped)?.[1])
    await sshUp(port)
    const hostKey = (await docker(['exec', id, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']))
      .split(' ')
      .slice(0, 2)
      .join(' ')
    return {
      endpoint: `127.0.0.1:${port}`,
      user: 'user',
      hostKey,
      authorize: async (publicKey) => {
        await docker(
          [
            'exec',
            '-i',
            '-u',
            'user',
            id,
            'sh',
            '-c',
            'cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
          ],
          `${publicKey}\n`,
        )
      },
      remove,
    }
  } catch (error) {
    await remove()
    throw error
  }
}

/** Boat's states of a sandbox that still runs, which the account's limits count. */
const LIVE_STATES = ['provisioned', 'cloning', 'starting', 'ready', 'idle', 'running']

/**
 * The run's sandboxes still live on the real Boat account in BOAT_API_KEY (or the one
 * BOAT_BASE_URL points at), by name, waiting up to `deadlineMs` for deletes to land.
 */
export async function boatSandboxesLeft(runId: string, deadlineMs = 30_000): Promise<string[]> {
  const sandbox = boat()
  const api = await boatClient(sandbox)
  const prefix = runPrefix(sandbox, runId)
  const until = Date.now() + deadlineMs
  let left: string[] = []
  do {
    const { sandboxes } = await api.sandboxes({ namePrefix: prefix, limit: 100 })
    left = sandboxes
      .filter((s) => s.name.startsWith(prefix) && LIVE_STATES.includes(s.state))
      .map((s) => `${s.name} (${s.state})`)
    if (!left.length) return []
    await new Promise((r) => setTimeout(r, 1000))
  } while (Date.now() < until)
  return left
}
