// A sandbox on a pooled Linux VM a provider starts in the run's main process (machine-service.ts)
// and an attempt reaches over SSH: `boat()` and `daytona()`. The provider's pool hands out slots;
// this sets up the attempt's slot over SSH and starts it through the shared sequence (start.ts).
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectSsh, type SshMachine, slotLayout } from '@reeval/sandbox-docker'
import { run } from '@reeval/sandbox-docker/process'
import { attemptDebug } from '../debug/attempt.ts'
import { egressLabel } from '../egress.ts'
import { registerSecret } from '../redact.ts'
import type { BoatSandboxDescriptor, DaytonaSandboxDescriptor } from '../types.ts'
import { harnessBake } from './harness-install.ts'
import type { SandboxOptions } from './index.ts'
import { leaseMachine } from './machine-service.ts'
import { startSandbox } from './start.ts'
import { InfraError, type NetworkSandbox } from './types.ts'

/** How a worker reaches a pooled machine: its SSH route, user and keys, in the main process's files. */
export type PooledSshMachine = {
  id: string
  name: string
  /** The provider's machine size, as the record names it. */
  size: string
  host: string
  port: number
  user: string
  identityFile: string
  knownHostsFile: string
  /** How the debug trace names the route: `198.51.100.7:19036 (public endpoint)`. */
  route: string
  /** The login user is a credential (a token), which every trace masks. */
  secretUser?: true
}

/** Past the attempt's timeout, so a machine whose worker was killed still goes away by itself. */
export const TTL_MARGIN_S = 600
/** How many times an attempt asks for another machine when the one it got fails to set up. */
const SETUP_TRIES = 3

/** Where the agent's Node lives when the VM's own is somewhere the sandbox user can't read. */
const AGENT_NODE = '/opt/reeval/node'
/**
 * A VM's `node` can link into the login user's nvm, under a home other users can't enter: give the
 * sandbox user its own copy of that Node, whose version the record names.
 */
const nodeForAgent = (user: string) =>
  [
    'real="$(readlink -f "$(command -v node)" 2>/dev/null || true)"',
    `{ [ -z "$real" ] || sudo -n -u ${user} test -x "$real" || [ -x ${AGENT_NODE}/bin/node ] || { rm -rf ${AGENT_NODE} && mkdir -p ${AGENT_NODE} && cp -a "$(dirname "$(dirname "$real")")/." ${AGENT_NODE} && chmod -R a+rX ${AGENT_NODE}; }; }`,
  ].join(' && ')

/** The harness install a machine keeps a home for, so its slots and resets copy it: by harness. */
const homeLabel = (options: SandboxOptions) => {
  const bake = options.harness && harnessBake(options.harness)
  return bake ? bake.label : undefined
}

/** A fresh ed25519 key pair in `dir`, made by the host's OpenSSH. */
export async function newKey(
  dir: string,
  provider: string,
): Promise<{ file: string; pub: string }> {
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
      `Couldn't make an SSH key for the ${provider} sandbox: ssh-keygen failed: ${made.stderr.trim()}`,
    )
  }
  return { file, pub: (await readFile(`${file}.pub`, 'utf8')).trim() }
}

/** The host's OpenSSH tools a pooled VM runs on, or the first one missing. */
export async function missingSshTool(
  tools: readonly (readonly [string, readonly string[]])[] = [
    ['ssh', ['-V']],
    ['ssh-keygen', ['-?']],
  ],
): Promise<string | null> {
  for (const [tool, args] of tools) {
    const r = await run(tool, [...args]).catch(() => null)
    if (!r) return tool
  }
  return null
}

export type PooledSshOptions = {
  /** How messages name the sandbox: `boat()`. */
  helper: string
  /** The record's provider: `boat`. */
  sandbox: string
  /** The size the record names when the descriptor sets none. */
  size: string
  /** How messages name one machine: `boat sandbox bx_… (small)`. */
  description(info: PooledSshMachine): string
}

/**
 * One attempt on a slot of `descriptor`'s pool: leases it, sets it up over SSH as its own user
 * (resetting a reused slot, copying the machine's harness install into a shared one's home) and
 * starts it. A reused slot that fails to set up is dropped and another leased, up to 3 times.
 */
export async function createPooledSshSandbox(
  descriptor: BoatSandboxDescriptor | DaytonaSandboxDescriptor,
  options: SandboxOptions,
  o: PooledSshOptions,
): Promise<NetworkSandbox> {
  const debug = attemptDebug()
  const shared = (descriptor.attemptsPerMachine ?? 1) > 1
  // A machine of its own that's never reused installs once anyway, so it keeps no copy.
  const label = shared || descriptor.reuse ? homeLabel(options) : undefined
  return startSandbox(options, {
    helper: o.helper,
    machine: { sandbox: o.sandbox, size: o.size },
    shared,
    install: true,
    networkNote: `network policy ${egressLabel(options.egress) || 'allow-all'} · the VM keeps its own network, so traffic that ignores the proxy goes out directly, unrecorded`,
    async boot() {
      for (let tries = 1; ; tries++) {
        const lease = await leaseMachine(
          {
            sandbox: descriptor,
            runId: options.runId,
            root: process.cwd(),
            ttlSeconds: Math.ceil(options.timeoutMs / 1000) + TTL_MARGIN_S,
          },
          options.signal,
        ).catch((error: unknown) => {
          if (options.signal.aborted) throw options.signal.reason
          throw error instanceof InfraError ? error : new InfraError((error as Error).message)
        })
        const info = lease.info as PooledSshMachine
        if (info.secretUser) registerSecret(info.user)
        debug?.log(
          'container',
          lease.start
            ? `created ${info.id} (${info.name}, ${info.size}) in ${lease.start.ms}ms${lease.start.queuedMs >= 1000 ? `, ${Math.round(lease.start.queuedMs / 1000)}s of it waiting for the account's start caps` : ''}${lease.start.rateLimited ? `, after ${lease.start.rateLimited} rate-limited starts` : ''}; slot ${lease.slot}`
            : `${lease.reused ? 'reused' : 'shared'} ${info.id} (${info.name}, ${info.size}); slot ${lease.slot}${lease.reused ? `, its attempt ${lease.reused + 1}` : ''}`,
        )
        for (const lost of lease.lost) {
          debug?.log('container', `dropped ${lost.machine}: keeping it alive failed: ${lost.error}`)
        }
        const layout = slotLayout(lease.slot)
        const dir = await mkdtemp(join(tmpdir(), `reeval-${o.sandbox}-ssh-`))
        let machine: SshMachine
        try {
          machine = await connectSsh({
            target: {
              host: info.host,
              port: info.port,
              user: info.user,
              identityFile: info.identityFile,
              knownHostsFile: info.knownHostsFile,
              hostKeyAlias: info.id,
              controlPath: join(dir, 'cm'),
            },
            description: o.description(info),
            env: options.env,
            path: [`${AGENT_NODE}/bin`],
            prepare: nodeForAgent(layout.user),
            abortSignal: options.signal,
            ...(shared && { layout }),
            ...(lease.reused && { reset: true }),
            ...(label && { home: label }),
          })
        } catch (error) {
          await rm(dir, { recursive: true, force: true })
          await lease.release(true)
          if (options.signal.aborted || !lease.reused || tries >= SETUP_TRIES) throw error
          debug?.log(
            'container',
            `${info.id} slot ${lease.slot} failed to reset: ${(error as Error).message}`,
          )
          continue
        }
        debug?.log('container', `ssh to ${info.id} over ${info.route}`)
        let healthy = true
        return {
          root: machine.root,
          ...(shared && { proxyPort: layout.proxyPort, stateDir: layout.state }),
          ...(label && {
            async installedElsewhere() {
              const got = await machine.home().catch((error: unknown) => {
                if (options.signal.aborted) throw error
                return { restored: false, waitedMs: 0, copyFailed: (error as Error).message }
              })
              const { restored, waitedMs, copyFailed } = got
              if (copyFailed && !restored) {
                debug?.log(
                  'container',
                  `no home from the machine's install, so this slot installs its own: ${copyFailed}`,
                )
              } else if (copyFailed) {
                debug?.log(
                  'container',
                  `the machine's first copy of the install didn't unpack: ${copyFailed}`,
                )
              }
              if (restored) {
                debug?.log(
                  'container',
                  `its home from the machine's install${waitedMs >= 1000 ? `, after waiting ${Math.round(waitedMs / 1000)}s for another slot to install it` : ''}`,
                )
              }
              return restored
            },
            async onInstalled() {
              await machine.snapshotHome().catch((error: unknown) => {
                debug?.log('container', `the machine keeps no copy of the install: ${error}`)
              })
            },
          }),
          session: (s) => machine.session(s),
          async destroy() {
            await machine.close()
            await rm(dir, { recursive: true, force: true })
            await lease.release(!healthy)
          },
          failed() {
            healthy = false
          },
        }
      }
    },
  })
}
