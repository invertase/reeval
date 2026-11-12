// cloud()'s VMs: boat.ts's client and pool under another name, with the service's URL and token
// from the environment.
import type { Check } from '../doctor.ts'
import { redactSecrets, registerSecret } from '../redact.ts'
import type { CloudMachineSize, CloudSandboxDescriptor } from '../types.ts'
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
/** The start of every cloud VM's name: hex follows it, never `run-`. */
export const CLOUD_PREFIX = 'reeval'

export const CLOUD: VmService = {
  helper: 'cloud()',
  kind: 'cloud',
  name: 'reeval',
  credential: `the token in ${VM_TOKEN}`,
  scope: 'run',
  starts: 'per run',
  maxLabels: 16,
  reservedLabels: 'reeval.platform.',
  expiry: ', which is no longer valid',
  ttlLimit: ': the VM service grants no more, so give the eval a shorter timeout',
  endsRun: ['run_cancelled', 'run_deadline'],
}

/** The machine type the service takes for each size. */
const TYPES: Record<CloudMachineSize, string> = {
  small: 'small',
  medium: 'default',
  large: 'large',
  xlarge: 'xlarge',
}

export const cloudSpec = (sandbox: CloudSandboxDescriptor): VmSpec => {
  const size = sandbox.size ?? 'small'
  return {
    prefix: CLOUD_PREFIX,
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
  stage: 'cloud',
  message: `cloud() needs its VM client, ${BOAT_SDK}, which isn't installed. Install it in this project: npm i ${BOAT_SDK}`,
})

/** Why this process can't reach the VM service, or null. */
export function cloudProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const unset = [VM_URL, VM_TOKEN].filter((name) => !env[name])
  if (unset.length) {
    return `cloud() needs ${VM_URL} and ${VM_TOKEN}, and ${unset.join(' and ')} ${unset.length > 1 ? "aren't" : "isn't"} set here. To run these evals elsewhere, pick another sandbox`
  }
  if (/\s/.test(env[VM_TOKEN] ?? '')) return `${VM_TOKEN} has whitespace or a line break in it`
  return null
}

/** A client for the VM service; the token goes from the environment to the client only. */
export async function cloudClient(projectRoot?: string): Promise<BoatClient> {
  const problem = cloudProblem()
  if (problem) {
    throw new PrepareError({
      class: 'config',
      stage: 'cloud',
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

export const openCloudPool: OpenPool<CloudSandboxDescriptor> = async (sandbox, o) =>
  openVmPool(CLOUD, cloudSpec(sandbox), await cloudClient(o.root), o.runId)

export function createCloudSandbox(
  descriptor: CloudSandboxDescriptor,
  options: SandboxOptions,
): Promise<NetworkSandbox> {
  return createPooledSshSandbox(descriptor, options, {
    helper: CLOUD.helper,
    sandbox: CLOUD.kind,
    size: descriptor.size ?? 'small',
    description: (info) => `cloud VM ${info.id} (${info.size})`,
  })
}

export const cloudCapacity = async (sandbox: CloudSandboxDescriptor) =>
  vmCapacity(CLOUD, cloudSpec(sandbox), await cloudClient().catch(() => null))

export const checkCloud = (sandbox: CloudSandboxDescriptor, projectRoot: string) =>
  checkVmService(CLOUD, cloudSpec(sandbox), () => cloudClient(projectRoot))

/** Deletes the VMs the run left. */
export async function removeRunVms(runId: string): Promise<void> {
  if (cloudProblem()) return
  const api = await cloudClient().catch(() => null)
  if (api) await removeNamed(api, runPrefix({ prefix: CLOUD_PREFIX }, runId))
}

/** `reeval doctor`: the OpenSSH client and the VM service, for each size `sandboxes` use. */
export async function cloudDoctor(
  sandboxes: readonly CloudSandboxDescriptor[],
  ctx: DoctorContext,
): Promise<Check[]> {
  if (!sandboxes.length) return []
  const missing = await ctx.deps.missingSshTool()
  const checks: Check[] = [
    missing
      ? {
          id: 'ssh',
          status: 'fail',
          summary: `cloud() runs every command over SSH, and there's no ${missing} on PATH`,
          fix: 'install an OpenSSH client (openssh-client on Debian and Ubuntu)',
        }
      : { id: 'ssh', status: 'ok', summary: 'an OpenSSH client for cloud()' },
  ]
  const problem = cloudProblem(ctx.deps.env)
  if (problem) {
    checks.push({ id: 'cloud', status: 'fail', summary: problem })
    return checks
  }
  const sizes = new Map(sandboxes.map((s) => [s.size ?? 'small', s]))
  for (const [size, sandbox] of sizes) {
    try {
      if (ctx.online) await checkCloud(sandbox, ctx.root)
      else await loadClient(ctx.root)
      checks.push({
        id: 'cloud',
        status: 'ok',
        summary: ctx.online
          ? `the VM service takes the token and starts ${size} machines`
          : `the VM client loads, and ${VM_URL} and ${VM_TOKEN} are set (--online asks the service whether it takes the token)`,
      })
    } catch (error) {
      checks.push({
        id: 'cloud',
        status: 'fail',
        summary: redactSecrets((error as Error).message),
      })
    }
  }
  return checks
}
