// hosted()'s VMs: boat.ts's client and pool under another name, with the service's URL and token
// from the environment.
import type { Check } from '../doctor.ts'
import { redactSecrets, registerSecret } from '../redact.ts'
import type { HostedMachineSize, HostedSandboxDescriptor } from '../types.ts'
import {
  BOAT_SDK,
  type BoatClient,
  type BoatSdk,
  checkVmService,
  openVmPool,
  removeNamed,
  runPrefix,
  type VmService,
  type VmSpec,
  vmCapacity,
} from './boat.ts'
import type { SandboxOptions } from './index.ts'
import type { DoctorContext } from './kinds.ts'
import type { OpenPool } from './machine-service.ts'
import { optionalPeer } from './optional-peer.ts'
import { PrepareError } from './provider.ts'
import { createPooledSshSandbox } from './ssh-pool.ts'
import type { NetworkSandbox } from './types.ts'

export const VM_URL = 'REEVAL_VM_URL'
export const VM_TOKEN = 'REEVAL_VM_TOKEN'
/** The start of every hosted VM's name: hex follows it, never `run-`. */
export const HOSTED_PREFIX = 'reeval'

export const HOSTED: VmService = {
  helper: 'hosted()',
  kind: 'hosted',
  name: 'reeval',
  credential: `the token in ${VM_TOKEN}`,
  scope: 'run',
  starts: 'per run',
  maxLabels: 16,
  reservedLabels: 'reeval.platform.',
  expiry: ', which is no longer valid',
  ttlLimit: ': the VM service grants no more, so give the eval a shorter timeout',
}

/** The machine type the service takes for each size. */
const TYPES: Record<HostedMachineSize, string> = {
  small: 'small',
  medium: 'default',
  large: 'large',
  xlarge: 'xlarge',
}

export const hostedSpec = (sandbox: HostedSandboxDescriptor): VmSpec => {
  const size = sandbox.size ?? 'small'
  return {
    prefix: HOSTED_PREFIX,
    type: TYPES[size],
    size,
    ...(sandbox.maxConcurrent !== undefined && { maxConcurrent: sandbox.maxConcurrent }),
    ...(sandbox.reuse !== undefined && { reuse: sandbox.reuse }),
    ...(sandbox.attemptsPerMachine !== undefined && {
      attemptsPerMachine: sandbox.attemptsPerMachine,
    }),
  }
}

const loadClient = optionalPeer<BoatSdk>(BOAT_SDK, {
  stage: 'hosted',
  message: `hosted() needs its VM client, ${BOAT_SDK}, which isn't installed. Install it in this project: npm i ${BOAT_SDK}`,
})

/** Why this process can't reach the VM service, or null. */
export function hostedProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const unset = [VM_URL, VM_TOKEN].filter((name) => !env[name])
  if (unset.length) {
    return `hosted() needs ${VM_URL} and ${VM_TOKEN}, and ${unset.join(' and ')} ${unset.length > 1 ? "aren't" : "isn't"} set here. To run these evals elsewhere, pick another sandbox`
  }
  if (/\s/.test(env[VM_TOKEN] ?? '')) return `${VM_TOKEN} has whitespace or a line break in it`
  return null
}

/** A client for the VM service; the token goes from the environment to the client only. */
export async function hostedClient(projectRoot?: string): Promise<BoatClient> {
  const problem = hostedProblem()
  if (problem) {
    throw new PrepareError({
      class: 'config',
      stage: 'hosted',
      ref: null,
      cause: null,
      log: null,
      usage: true,
      message: `${problem}.`,
    })
  }
  const { BoatApi, Configuration } = await loadClient(projectRoot)
  const accessToken = process.env[VM_TOKEN]
  registerSecret(accessToken)
  return new BoatApi(new Configuration({ accessToken, basePath: process.env[VM_URL] }))
}

export const openHostedPool: OpenPool<HostedSandboxDescriptor> = async (sandbox, o) =>
  openVmPool(HOSTED, hostedSpec(sandbox), await hostedClient(o.root), o.runId)

export function createHostedSandbox(
  descriptor: HostedSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  return createPooledSshSandbox(descriptor, options, {
    helper: HOSTED.helper,
    sandbox: HOSTED.kind,
    size: descriptor.size ?? 'small',
    description: (info) => `hosted VM ${info.id} (${info.size})`,
  })
}

export const hostedCapacity = async (sandbox: HostedSandboxDescriptor) =>
  vmCapacity(HOSTED, hostedSpec(sandbox), await hostedClient().catch(() => null))

export const checkHosted = (sandbox: HostedSandboxDescriptor, projectRoot: string) =>
  checkVmService(HOSTED, hostedSpec(sandbox), () => hostedClient(projectRoot))

/** Deletes the VMs the run left. */
export async function removeRunVms(runId: string): Promise<void> {
  if (hostedProblem()) return
  const api = await hostedClient().catch(() => null)
  if (api) await removeNamed(api, runPrefix({ prefix: HOSTED_PREFIX }, runId))
}

/** `reeval doctor`: the OpenSSH client and the VM service, for each size `sandboxes` use. */
export async function hostedDoctor(
  sandboxes: readonly HostedSandboxDescriptor[],
  ctx: DoctorContext,
): Promise<Check[]> {
  if (!sandboxes.length) return []
  const missing = await ctx.deps.missingSshTool()
  const checks: Check[] = [
    missing
      ? {
          id: 'ssh',
          status: 'fail',
          summary: `hosted() runs every command over SSH, and there's no ${missing} on PATH`,
          fix: 'install an OpenSSH client (openssh-client on Debian and Ubuntu)',
        }
      : { id: 'ssh', status: 'ok', summary: 'an OpenSSH client for hosted()' },
  ]
  const problem = hostedProblem(ctx.deps.env)
  if (problem) {
    checks.push({ id: 'hosted', status: 'fail', summary: problem })
    return checks
  }
  const sizes = new Map(sandboxes.map((s) => [s.size ?? 'small', s]))
  for (const [size, sandbox] of sizes) {
    try {
      if (ctx.online) await checkHosted(sandbox, ctx.root)
      else await loadClient(ctx.root)
      checks.push({
        id: 'hosted',
        status: 'ok',
        summary: ctx.online
          ? `the VM service takes the token and starts ${size} machines`
          : `the VM client loads, and ${VM_URL} and ${VM_TOKEN} are set (--online asks the service whether it takes the token)`,
      })
    } catch (error) {
      checks.push({
        id: 'hosted',
        status: 'fail',
        summary: redactSecrets((error as Error).message),
      })
    }
  }
  return checks
}
