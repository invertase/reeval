import { imageInfo, LABEL } from '@evalsuite/sandbox-docker'
import { UsageError } from './errors.ts'
import { sandboxId } from './options.ts'
import {
  type PrepareEvent,
  type PrepareUse,
  prepareAll,
  prepareTargets,
  RunStopError,
  writePrepared,
} from './sandbox/preflight.ts'
import { imageHarness } from './sandbox/prepare.ts'
import { PrepareError, type SandboxProvider } from './sandbox/provider.ts'
import { createProviders } from './sandbox/providers.ts'
import type { AttemptImage } from './types.ts'

export type SandboxImage = {
  ref: string
  id: string
  repoDigests: string[]
  agentCli: string | null
}
/** The Docker images preflight prepared for the run. */
export type SandboxVersions = { images: SandboxImage[] }

/** How the terminal names a sandbox to prepare: its cell id, `+ install`, and a harness other than Cursor. */
export function prepareLabel({ sandbox, harness }: Pick<PrepareUse, 'sandbox' | 'harness'>) {
  if (sandbox.kind !== 'docker') return sandboxId(sandbox)
  const baked = imageHarness(harness)
  const install = sandbox.install?.length ? ' + install' : ''
  return `${sandboxId(sandbox)}${install}${baked === 'cursor' ? '' : ` · ${baked}`}`
}

/** A run that stopped in preflight on an infra failure: exit 3. */
export class PreflightInfraError extends Error {
  override name = 'PreflightInfraError'
}

/**
 * Before any eval starts: checks each sandbox provider, then prepares every distinct sandbox the
 * planned attempts need (building Docker images), in parallel, and writes the results for the
 * run's workers. A config-level sandbox that fails stops the run (exit 2 for a mistake in the
 * config, exit 3 otherwise); any other failure fails only the attempts that need it.
 */
export async function preflight(
  uses: PrepareUse[],
  options: {
    root: string
    runId: string
    onEvent?: (e: PrepareEvent) => void
    signal?: AbortSignal
    providers?: Record<string, SandboxProvider>
    delays?: number[]
  },
): Promise<SandboxVersions> {
  const providers = options.providers ?? createProviders()
  const targets = prepareTargets(uses, providers, prepareLabel)
  if (!targets.some((t) => t.kind !== 'fake')) return { images: [] }
  let outcomes: Awaited<ReturnType<typeof prepareAll>>
  try {
    outcomes = await prepareAll(targets, {
      providers,
      root: options.root,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.delays ? { delays: options.delays } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      log: (line) => process.env.ES_DEBUG && console.error(line),
    })
  } catch (error) {
    if (error instanceof PrepareError) {
      throw error.failure.usage
        ? new UsageError(error.message)
        : new PreflightInfraError(error.message)
    }
    if (error instanceof RunStopError) {
      throw error.outcome.failure.usage
        ? new UsageError(error.message)
        : new PreflightInfraError(error.message)
    }
    throw error
  }
  writePrepared(options.root, options.runId, outcomes)
  const images: SandboxImage[] = []
  for (const o of outcomes) {
    if (!o.ok || o.target.kind !== 'docker') continue
    const { ref, id, agentCli } = o.handle as unknown as AttemptImage
    if (images.some((i) => i.id === id)) continue
    const info = await imageInfo(ref)
    images.push({
      ref,
      id,
      repoDigests: info?.repoDigests ?? [],
      agentCli: agentCli ?? info?.labels[LABEL.agentVersion] ?? null,
    })
  }
  return { images }
}
