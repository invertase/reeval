// boat.dev VMs as sandboxes: the Boat SDK (an optional peer, imported only here) creates and deletes
// them, and every process runs over SSH with a per-attempt key, the egress gateway's forwarder
// included, so credentials stay on the host as they do for Docker.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSshSession, EgressUnavailableError, SANDBOX_USER } from '@reeval/sandbox-docker'
import { run } from '@reeval/sandbox-docker/process'
import { egressLabel } from '../egress.ts'
import { registerSecret } from '../redact.ts'
import type { BoatSandboxDescriptor } from '../types.ts'
import { gatewayGlue, sessionSandbox } from './docker.ts'
import type { SandboxOptions } from './index.ts'
import { PrepareError } from './provider.ts'
import { harnessBake } from './tart-bake.ts'
import { InfraError, type NetworkSandbox } from './types.ts'

const BOAT_SDK = '@boatdev/sdk'
export const BOAT_BASE_URL = 'BOAT_BASE_URL'

/** What reeval reads of a sandbox, typed here so no SDK type reaches reeval's own. */
type BoatSandboxInfo = {
  id: string
  name: string
  state: string
  error?: string | null
}

/** The SDK calls reeval makes. */
export type BoatClient = {
  create(p: {
    idempotencyKey?: string
    createSandboxRequest: {
      type: string
      name: string
      ttlSeconds: number
      noEnv: boolean
      snapshots: boolean
      monitoring: boolean
    }
  }): Promise<{ sandbox: BoatSandboxInfo }>
  get(p: { sandboxId: string }): Promise<{ sandbox: BoatSandboxInfo }>
  sshKey(p: { sandboxId: string; sshKeyRequest: { key: string } }): Promise<{
    sshUser?: string
    sshEndpoint?: string | null
    hostKey?: string
  }>
  sandboxes(
    p: { namePrefix?: string; limit?: number; cursor?: string },
    init?: { signal?: AbortSignal },
  ): Promise<{
    sandboxes: BoatSandboxInfo[]
    pageInfo?: { nextCursor: string | null; hasMore: boolean }
  }>
  deleteSandbox(
    p: { sandboxId: string; xAsciiConfirmDelete: string },
    init?: { signal?: AbortSignal },
  ): Promise<unknown>
  limits(
    p?: Record<string, never>,
    init?: { signal?: AbortSignal },
  ): Promise<{
    canStart: boolean
    startBlockedReason?: string
    activeSandboxes: number
    maxActiveSandboxes: number
    machineTypes?: Array<{ type: string; available: boolean; reason: string | null }>
  }>
}

type BoatSdk = {
  BoatApi: new (configuration: unknown) => BoatClient
  Configuration: new (p: { basePath?: string; accessToken?: string }) => unknown
}

/** The fix for a project without the SDK. */
export const INSTALL_SDK = `Install the Boat SDK in this project: npm i ${BOAT_SDK}`

const missing = (error: unknown) =>
  (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' ||
  (error as { code?: string }).code === 'MODULE_NOT_FOUND'

let loaded: Promise<BoatSdk> | undefined
/**
 * The Boat SDK, from beside reeval or else from the project: a package manager that doesn't link
 * peers into reeval's own `node_modules` still has it in the project's.
 */
export function loadBoatSdk(projectRoot = process.cwd()): Promise<BoatSdk> {
  loaded ??= (async () => {
    try {
      return (await import(BOAT_SDK)) as BoatSdk
    } catch (error) {
      if (!missing(error)) throw error
    }
    try {
      const path = createRequire(join(projectRoot, 'noop.js')).resolve(BOAT_SDK)
      return (await import(pathToFileURL(path).href)) as BoatSdk
    } catch (error) {
      if (!missing(error)) throw error
      throw new PrepareError({
        class: 'config',
        stage: 'boat',
        ref: null,
        cause: null,
        log: null,
        usage: true,
        message: `boat() needs the Boat SDK, which isn't installed. ${INSTALL_SDK}`,
      })
    }
  })()
  loaded.catch(() => {
    loaded = undefined
  })
  return loaded
}

/** Why `sandbox`'s key can't be read from this process's environment, or null. */
export function boatKeyProblem(sandbox: Pick<BoatSandboxDescriptor, 'apiKey'>): string | null {
  const name = sandbox.apiKey.from
  const value = process.env[name]
  if (!value) return `boat() needs a Boat API key in ${name}, which isn't set`
  if (/\s/.test(value)) {
    return `${name} has whitespace or a line break in it (a key pasted from a wrapped line?); set it to the key alone`
  }
  return null
}

/** A client for `sandbox`'s account; the key goes from the environment to the SDK, nowhere else. */
export async function boatClient(
  sandbox: Pick<BoatSandboxDescriptor, 'apiKey'>,
  projectRoot?: string,
): Promise<BoatClient> {
  const problem = boatKeyProblem(sandbox)
  if (problem) {
    throw new PrepareError({
      class: 'config',
      stage: 'boat',
      ref: null,
      cause: null,
      log: null,
      usage: true,
      message: `${problem}. Set it in the environment or the project's .env.local.`,
    })
  }
  const { BoatApi, Configuration } = await loadBoatSdk(projectRoot)
  const basePath = process.env[BOAT_BASE_URL]
  const accessToken = process.env[sandbox.apiKey.from]
  // A variable whose name doesn't look secret (`BOAT_PROD`) isn't masked by name.
  registerSecret(accessToken)
  return new BoatApi(
    new Configuration({
      accessToken,
      ...(basePath ? { basePath } : {}),
    }),
  )
}

/** What Boat said about a failed call: `404 not_found: …`, or the error's own message. */
export async function boatError(error: unknown): Promise<string> {
  const response = (error as { response?: Response }).response
  if (!response) return error instanceof Error ? error.message : String(error)
  const body = await response.text().catch(() => '')
  let detail = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } | string }
    const e = parsed.error
    if (typeof e === 'string') detail = e
    else if (e) detail = [e.code, e.message].filter(Boolean).join(': ')
  } catch {}
  return `${response.status}${detail ? ` ${detail}` : ''}`
}

const status = (error: unknown) => (error as { response?: Response }).response?.status

/** The part of every sandbox name that says which run made it. */
export const runTag = (runId: string) =>
  createHash('sha256').update(runId).digest('hex').slice(0, 8)

/** `<prefix>-<run>-`: what every sandbox of the run is named with first. */
export const runPrefix = (sandbox: Pick<BoatSandboxDescriptor, 'prefix'>, runId: string) =>
  `${sandbox.prefix}-${runTag(runId)}-`

/** How long a created sandbox may take to be ready. */
const READY_TIMEOUT_MS = 120_000
/** How long a check of the account may wait on Boat, so an unreachable API can't stall a plan. */
const LIMITS_TIMEOUT_MS = 15_000
/** How long a run's cleanup may wait on one account, so an unreachable API can't stall a resume. */
const CLEANUP_TIMEOUT_MS = 15_000
/** Boat's states a sandbox never leaves for `ready`; 'cancelled' answers 404 after it's reported. */
const DEAD_STATES = ['archived', 'archiving', 'error', 'cancelled']
/** Past the attempt's timeout, so a sandbox whose worker was killed still goes away by itself. */
const TTL_MARGIN_S = 600

async function untilReady(
  api: BoatClient,
  id: string,
  signal: AbortSignal,
): Promise<BoatSandboxInfo> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const { sandbox } = await api.get({ sandboxId: id }).catch(async (error: unknown) => {
      throw new InfraError(`Boat didn't report sandbox ${id}: ${await boatError(error)}`)
    })
    if (['ready', 'idle', 'running'].includes(sandbox.state)) return sandbox
    if (DEAD_STATES.includes(sandbox.state)) {
      throw new InfraError(
        `Boat sandbox ${id} stopped starting: ${sandbox.state}${sandbox.error ? ` (${sandbox.error})` : ''}`,
      )
    }
    if (Date.now() > deadline) {
      throw new InfraError(
        `Boat sandbox ${id} wasn't ready after ${READY_TIMEOUT_MS / 1000}s (still ${sandbox.state})`,
      )
    }
    if (signal.aborted) throw signal.reason
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/** Deletes a sandbox; one already gone is deleted. */
async function deleteSandbox(api: BoatClient, id: string, signal?: AbortSignal): Promise<void> {
  try {
    await api.deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id }, { signal })
  } catch (error) {
    if (status(error) !== 404) throw error
  }
}

/** A fresh ed25519 key pair in `dir`, made by the host's OpenSSH. */
async function newKey(dir: string): Promise<{ file: string; pub: string }> {
  const file = join(dir, 'id_ed25519')
  const made = await run('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'reeval',
    '-f',
    file,
  ])
  if (made.exitCode !== 0) {
    throw new InfraError(
      `Couldn't make an SSH key for the Boat sandbox: ssh-keygen failed: ${made.stderr.trim()}`,
    )
  }
  return { file, pub: (await readFile(`${file}.pub`, 'utf8')).trim() }
}

/** Where the agent's Node lives when the VM's own is somewhere the sandbox user can't read. */
const AGENT_NODE = '/opt/reeval/node'
/**
 * Boat's `/usr/local/bin/node` links into the login user's nvm, under a home other users can't
 * enter: give the sandbox user its own copy of that Node, whose version the record names.
 */
const NODE_FOR_AGENT = [
  'real="$(readlink -f "$(command -v node)" 2>/dev/null || true)"',
  `{ [ -z "$real" ] || sudo -n -u ${SANDBOX_USER} test -x "$real" || { rm -rf ${AGENT_NODE} && mkdir -p ${AGENT_NODE} && cp -a "$(dirname "$(dirname "$real")")/." ${AGENT_NODE} && chmod -R a+rX ${AGENT_NODE}; }; }`,
].join(' && ')

export async function createBoatSandbox(
  descriptor: BoatSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  const api = await boatClient(descriptor).catch((error: unknown) => {
    throw error instanceof PrepareError ? new InfraError(error.message) : error
  })
  const glue = gatewayGlue(options)
  const { brokered, debug } = glue
  const type = descriptor.type ?? 'small'
  const name = `${runPrefix(descriptor, options.runId)}${randomBytes(3).toString('hex')}`
  const started = performance.now()
  const dir = await mkdtemp(join(tmpdir(), 'reeval-boat-'))
  let id: string | undefined
  // The session's destroy and a failed start both clean up; the VM is deleted once.
  let cleaned: Promise<void> | undefined
  const cleanUp = () =>
    (cleaned ??= (async () => {
      if (id) await deleteSandbox(api, id).catch(() => {})
      await rm(dir, { recursive: true, force: true })
    })())
  try {
    const key = await newKey(dir)
    const made = await api
      .create({
        idempotencyKey: name,
        createSandboxRequest: {
          type,
          name,
          ttlSeconds: Math.ceil(options.timeoutMs / 1000) + TTL_MARGIN_S,
          noEnv: true,
          snapshots: false,
          monitoring: false,
        },
      })
      .catch(async (error: unknown) => {
        throw new InfraError(`Boat didn't create a sandbox: ${await boatError(error)}`)
      })
    id = made.sandbox.id
    await untilReady(api, id, options.signal)
    const ssh = await api
      .sshKey({ sandboxId: id, sshKeyRequest: { key: key.pub } })
      .catch(async (error: unknown) => {
        throw new InfraError(
          `Boat didn't authorize the attempt's SSH key: ${await boatError(error)}`,
        )
      })
    const endpoint = /^(.+):(\d+)$/.exec(ssh.sshEndpoint ?? '')
    if (!endpoint || !ssh.hostKey) {
      throw new InfraError(`Boat gave sandbox ${id} no SSH endpoint and host key to connect with`)
    }
    const knownHostsFile = join(dir, 'known_hosts')
    await writeFile(knownHostsFile, `${id} ${ssh.hostKey.trim()}\n`)
    debug?.log(
      'container',
      `created ${id} (${name}, ${type}) in ${Math.round(performance.now() - started)}ms`,
    )
    const network = await createSshSession({
      target: {
        host: endpoint[1] as string,
        port: Number(endpoint[2]),
        user: ssh.sshUser ?? 'user',
        identityFile: key.file,
        knownHostsFile,
        hostKeyAlias: id,
        controlPath: join(dir, 'cm'),
      },
      description: `boat sandbox ${id} (${type})`,
      env: options.env,
      path: [`${AGENT_NODE}/bin`],
      prepare: NODE_FOR_AGENT,
      abortSignal: options.signal,
      egress: glue.egress,
      onDestroy: cleanUp,
    }).catch((error: unknown) => {
      throw error instanceof EgressUnavailableError
        ? new InfraError(
            `Can't keep ${brokered.join(', ') || 'brokered values'} out of the Boat sandbox: the egress gateway could not start (${error.reason})`,
          )
        : error
    })
    debug?.log(
      'container',
      `network policy ${egressLabel(options.egress) || 'allow-all'} · the VM keeps its own network, so traffic that ignores the proxy goes out directly, unrecorded`,
    )
    debug?.log(
      'container',
      network.egress?.active
        ? `egress gateway started · brokers ${brokered.join(', ') || 'nothing'}`
        : `egress gateway not running: ${network.egress?.reason ?? 'not asked for'}`,
    )
    if (network.egress?.active === false && brokered.length > 0) {
      await network.destroy()
      throw new InfraError(
        `Can't keep ${brokered.join(', ')} out of the Boat sandbox: credential brokering could not start (${network.egress.reason})`,
      )
    }
    // A VM has nothing baked in, so the CLI downloads here, on the sandbox's own allowance: in
    // the harness's start, a slow download would spend its readiness window and be tried again.
    const bake = options.harness && harnessBake(options.harness)
    if (bake) {
      const installing = performance.now()
      const version = await bake.install(network).catch(async (error: unknown) => {
        await network.destroy()
        throw options.signal.aborted
          ? error
          : new InfraError(
              `Installing ${bake.name} in Boat sandbox ${id} failed: ${(error as Error).message}`,
            )
      })
      debug?.log(
        'container',
        `installed ${bake.name} ${version} in ${Math.round(performance.now() - installing)}ms`,
      )
    }
    return await sessionSandbox(network, glue, { oomKills: async () => null })
  } catch (error) {
    await cleanUp()
    throw error
  }
}

/** Every sandbox on `sandbox`'s account whose name starts with `prefix`, across pages. */
async function sandboxesNamed(
  api: BoatClient,
  prefix: string,
  signal: AbortSignal,
): Promise<BoatSandboxInfo[]> {
  const found: BoatSandboxInfo[] = []
  let cursor: string | undefined
  do {
    const page = await api.sandboxes(
      { namePrefix: prefix, limit: 100, ...(cursor && { cursor }) },
      { signal },
    )
    found.push(...page.sandboxes.filter((s) => s.name.startsWith(prefix)))
    cursor = page.pageInfo?.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined
  } while (cursor)
  return found
}

/**
 * Deletes every sandbox the run left on each account and prefix in `sandboxes`. Nothing else
 * names them: another prefix, or another run's tag, is someone else's.
 */
export async function removeRunSandboxes(
  runId: string,
  sandboxes: readonly BoatSandboxDescriptor[],
): Promise<void> {
  const seen = new Set<string>()
  for (const sandbox of sandboxes) {
    const prefix = runPrefix(sandbox, runId)
    const key = `${sandbox.apiKey.from}\0${prefix}`
    if (seen.has(key) || boatKeyProblem(sandbox)) continue
    seen.add(key)
    const api = await boatClient(sandbox).catch(() => null)
    if (!api) continue
    const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
    const left = await sandboxesNamed(api, prefix, signal).catch(() => [])
    await Promise.all(left.map((s) => deleteSandbox(api, s.id, signal).catch(() => {})))
  }
}

/** Machines Boat would still start for the account: its cap on sandboxes at once, less what's running. */
export async function boatCapacity(sandbox: BoatSandboxDescriptor): Promise<number | null> {
  const api = await boatClient(sandbox).catch(() => null)
  const limits = await api
    ?.limits({}, { signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS) })
    .catch(() => null)
  return limits ? Math.max(0, limits.maxActiveSandboxes - limits.activeSandboxes) : null
}

/** The host's OpenSSH tools a Boat sandbox runs on, or the first one missing. */
export async function missingSshTool(): Promise<string | null> {
  for (const [tool, args] of [
    ['ssh', ['-V']],
    ['ssh-keygen', ['-?']],
  ] as const) {
    const r = await run(tool, [...args]).catch(() => null)
    if (!r) return tool
  }
  return null
}

/**
 * Preflight's check of one account: the host has OpenSSH, the key is set, the SDK loads, Boat
 * takes the key and would start the machine size asked for.
 */
export async function checkBoat(sandbox: BoatSandboxDescriptor, projectRoot: string) {
  const refuse = (message: string, usage: boolean) =>
    new PrepareError({
      class: 'config',
      stage: 'boat',
      ref: null,
      cause: null,
      log: null,
      usage,
      message,
    })
  const tool = await missingSshTool()
  if (tool) {
    throw refuse(
      `boat() runs every command over SSH, and there's no ${tool} on PATH: install an OpenSSH client (openssh-client on Debian and Ubuntu)`,
      true,
    )
  }
  const api = await boatClient(sandbox, projectRoot)
  const limits = await api
    .limits({}, { signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS) })
    .catch(async (error: unknown) => {
      const code = status(error)
      if (code === 401 || code === 403) {
        throw refuse(
          `Boat refused the API key in ${sandbox.apiKey.from}: ${await boatError(error)}`,
          true,
        )
      }
      throw new PrepareError({
        class: 'transient',
        stage: 'boat',
        ref: null,
        cause: null,
        log: null,
        message: `Couldn't reach Boat: ${await boatError(error)}`,
      })
    })
  const type = sandbox.type ?? 'small'
  const machine = limits.machineTypes?.find((m) => m.type === type)
  if (machine && !machine.available) {
    throw refuse(
      `Boat won't start a ${type} machine on this account: ${machine.reason ?? 'unavailable'}`,
      true,
    )
  }
  if (!limits.canStart) {
    throw refuse(
      `Boat won't start sandboxes on this account: ${limits.startBlockedReason ?? 'no reason given'}`,
      false,
    )
  }
}
