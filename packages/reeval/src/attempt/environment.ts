import { attemptDebug, debugLog } from '../debug/attempt.ts'
import { allowedHosts } from '../egress.ts'
import { builtPlugins, pluginBuildId } from '../environment/plugins.ts'
import { resolveEnvironment } from '../environment/resolve.ts'
import { layoutOf } from '../harness/index.ts'
import { InfraError } from '../sandbox/types.ts'
import { preparedWorkspace } from '../workspace.ts'
import { traceEnvironment } from './debug.ts'
import type { Attempt } from './state.ts'

/**
 * Resolves the attempt's environment (files, skills, secrets and their placeholders)
 * and finds the image a Docker sandbox starts from, which preflight prepared. Runs on the test's
 * signal, before the eval timer starts.
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
    { harness: spec.harness, allowed: allowedHosts(spec.egress) },
  )
  a.env = env
  record.environment = env.record
  const { secrets, brokered } = env.record
  record.env = {
    vars: Object.keys(env.vars)
      .filter((n) => !secrets.includes(n))
      .sort(),
    secrets,
    brokered,
  }
  const debug = attemptDebug()
  if (debug) traceEnvironment(debug, spec, env)
  record.image = null
  if (spec.sandbox.kind === 'docker') {
    const { preparedFor } = await import('../sandbox/preflight.ts')
    const { attemptImage, dockerProvider, preparedImage } = await import('../sandbox/providers.ts')
    signal.throwIfAborted()
    // Preflight prepared every image before the run: an attempt only looks its image up.
    const provider = dockerProvider({ engine: spec.sandbox.engine ?? 'docker' })
    const builds = builtPlugins(spec.environment.layers)
    const prepared = preparedFor(root, runId, provider, spec.sandbox, spec.harness, builds)
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
  } else {
    debugLog('image', `none: the ${spec.sandbox.kind} sandbox runs on the host`)
  }
}
