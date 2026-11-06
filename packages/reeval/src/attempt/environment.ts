import { attemptDebug, debugLog } from '../debug/attempt.ts'
import { allowedHosts } from '../egress.ts'
import { builtPlugins, pluginBuildId } from '../environment/plugins.ts'
import { resolveEnvironment } from '../environment/resolve.ts'
import { layoutOf } from '../harness/index.ts'
import { sandboxKind } from '../sandbox/kinds.ts'
import { InfraError } from '../sandbox/types.ts'
import { preparedWorkspace } from '../workspace.ts'
import { traceEnvironment } from './debug.ts'
import type { Attempt } from './state.ts'

/**
 * Resolves the attempt's environment (files, skills, secrets and their placeholders)
 * and finds the image its sandbox starts from, when its kind has one, which preflight prepared.
 * Runs on the test's signal, before the eval timer starts.
 */
export async function prepareEnvironment(
  a: Attempt,
  root: string,
  runId: string,
  where: string,
  signal: AbortSignal,
): Promise<void> {
  const { spec, record } = a
  const env = await resolveEnvironment(
    spec.environment,
    spec.env,
    root,
    where,
    layoutOf(spec.harness).rulesFile,
    spec.egress.policy,
    (w) => preparedWorkspace(root, runId, w),
    {
      harness: spec.harness,
      allowed: allowedHosts(spec.egress),
      ...(spec.egress.setup ? { setupEgress: spec.egress.setup.policy } : {}),
    },
  )
  a.env = env
  record.environment = env.record
  const { vars, secrets, brokered } = env.record
  record.env = { vars, secrets, brokered }
  const debug = attemptDebug()
  if (debug) traceEnvironment(debug, spec, env)
  record.image = null
  const kind = sandboxKind(spec.sandbox)
  if (kind.capabilities.images) {
    const { preparedFor } = await import('../sandbox/preflight.ts')
    const { attemptImage, createProviders, preparedImage } = await import('../sandbox/providers.ts')
    signal.throwIfAborted()
    // Preflight prepared every image before the run: an attempt only looks its image up.
    const provider = createProviders()[kind.provider(spec.sandbox)]
    const builds = builtPlugins(spec.environment.layers)
    const prepared =
      provider && preparedFor(root, runId, provider, spec.sandbox, spec.harness, builds)
    if (!prepared) {
      throw new InfraError(`The sandbox image for ${where} wasn't prepared before the run started`)
    }
    record.image = attemptImage(prepared)
    a.image = record.image.ref
    const built = preparedImage(prepared).plugins ?? []
    for (const [i, plugin] of env.plugins.entries()) {
      if (plugin.declared.build === undefined) continue
      const found = built.find((b) => b.id === pluginBuildId(plugin.declared))
      if (!found) {
        throw new InfraError(
          `The ${plugin.name} plugin's build for ${where} wasn't prepared before the run started`,
        )
      }
      if (found.commit !== plugin.commit) {
        throw new InfraError(
          `The ${plugin.name} plugin's ref moved during the run: it was built at ${found.commit?.slice(0, 12)} and is now ${plugin.commit?.slice(0, 12)}. Pin ref to a commit or tag.`,
        )
      }
      plugin.built = { dir: found.dir, tag: found.tag }
      const pluginRecord = env.record.plugins?.[i]
      if (pluginRecord) pluginRecord.build = found.tag
      debugLog('image', `plugin ${plugin.name} built in ${found.tag}`)
    }
    const { ref, id, base, install, agentCli } = record.image
    debugLog(
      'image',
      `ready ${ref} (${id.replace(/^sha256:/, '').slice(0, 12)}) · prepared before the run${ref !== base ? ` · on ${base}` : ''}${agentCli ? ` · agent CLI ${agentCli}` : ''}${install.length ? ` · install: ${install.join(' && ')}` : ''}`,
    )
  } else if (kind.capabilities.isolated) {
    const { preparedFor } = await import('../sandbox/preflight.ts')
    const { bakedImage, createProviders, preparedHosts, vmImage } = await import(
      '../sandbox/providers.ts'
    )
    const provider = createProviders()[kind.provider(spec.sandbox)]
    const prepared = provider && preparedFor(root, runId, provider, spec.sandbox, spec.harness)
    const vm = prepared ? vmImage(prepared) : null
    if (vm) record.vmImage = vm
    const baked = prepared ? bakedImage(prepared) : null
    if (baked) a.image = baked
    const hosts = prepared ? preparedHosts(prepared) : null
    if (hosts) a.hosts = hosts
    const from = vm?.ref ?? ('image' in spec.sandbox ? spec.sandbox.image : undefined)
    debugLog(
      'image',
      `${from ?? 'none recorded'}${vm?.digest ? ` (${vm.digest})` : ''} · ${kind.helpers[0]}() checked it before the run and starts each attempt from ${baked ? `${baked}, which has the harness baked in` : 'it'}`,
    )
  } else {
    debugLog(
      'image',
      kind.capabilities.isolated
        ? `none: the ${spec.sandbox.kind} sandbox starts from its provider's base`
        : `none: the ${spec.sandbox.kind} sandbox runs on the host`,
    )
  }
}
