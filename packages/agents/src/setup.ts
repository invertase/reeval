import { posix } from 'node:path'
import type { HarnessV1, HarnessV1Bootstrap } from '@ai-sdk/harness'
import { createHarnessSandboxTemplate } from '@ai-sdk/harness/agent'
import type { AgentKind, HarnessCatalogEntry } from './catalog/entry.ts'
import { HARNESSES } from './catalog/index.ts'
import { AgentError } from './errors.ts'
import type { Runner } from './runner.ts'
import { runnerSession } from './runner-session.ts'

/**
 * Whether a session installs its harness's CLI: `auto` when the runner doesn't have this build
 * of it yet, `always` again even when it does, `skip` never, refusing a runner that doesn't.
 */
export type InstallMode = 'auto' | 'skip' | 'always'

/** How a harness's CLI gets onto a machine: what installs it, and how to tell it's there. */
export type HarnessSetup = {
  /** How progress and errors name the harness. */
  readonly name: string
  /** The binary the install leaves under `~/.ai-sdk-harness`, or the package it installs. */
  readonly cli: string
  /** For an adapter that leaves no binary: a command that prints what it installed. */
  readonly probe?: string
  /** The adapter, with placeholder auth: only its install is read. */
  readonly adapter: () => Promise<HarnessV1>
  /** What the install writes and runs; undefined for an adapter with nothing to install. */
  readonly recipe: () => Promise<HarnessV1Bootstrap | undefined>
  /** The host variables it authenticates with, in the order it takes them. */
  readonly credentials: readonly string[]
  /** The platforms the install puts its CLI on. */
  readonly platforms: readonly NodeJS.Platform[]
}

type Install = Pick<HarnessSetup, 'cli' | 'probe' | 'adapter'>

const INSTALLS: Record<AgentKind, Install> = {
  cursor: {
    cli: '@cursor/sdk',
    probe: `node -p "'@cursor/sdk ' + require(process.env.HOME + '/.ai-sdk-harness/.harness-bootstrap/cursor-sdk/node_modules/@cursor/sdk/package.json').version"`,
    adapter: async () => (await import('@reeval/harness-cursor-sdk')).createCursorSdk(),
  },
  'claude-code': {
    cli: 'claude',
    adapter: async () => (await import('@ai-sdk/harness-claude-code')).createClaudeCode(),
  },
  antigravity: {
    cli: 'agy',
    adapter: async () => (await import('@reeval/harness-antigravity')).createAntigravity(),
  },
  opencode: {
    cli: 'opencode',
    adapter: async () =>
      (await import('@reeval/harness-opencode')).createOpenCode({
        auth: { GOOGLE_GENERATIVE_AI_API_KEY: 'unused' },
        model: 'google/unused',
      }),
  },
  goose: {
    cli: 'goose',
    adapter: async () => {
      const goose = await import('@reeval/harness-goose')
      return goose.createGoose({
        auth: { GOOGLE_API_KEY: 'unused' },
        provider: goose.GEMINI_PROVIDER,
        model: 'unused',
      })
    },
  },
  pi: {
    cli: 'pi',
    adapter: async () => {
      const pi = await import('@reeval/harness-pi')
      const provider = pi.piProvider('google')
      if ('refused' in provider) throw new Error(provider.refused)
      return pi.createPi({ auth: { GEMINI_API_KEY: 'unused' }, provider })
    },
  },
  codex: {
    cli: 'codex',
    adapter: async () =>
      (await import('@reeval/harness-codex')).createCodex({ auth: { OPENAI_API_KEY: 'unused' } }),
  },
  fx: {
    cli: 'fx',
    adapter: async () =>
      (await import('@reeval/harness-fx')).createFx({
        auth: { AI_GATEWAY_API_KEY: 'unused' },
        model: 'unused/unused',
      }),
  },
  'grok-build': {
    cli: 'grok',
    adapter: async () =>
      (await import('@reeval/harness-grok-build')).createGrokBuild({
        auth: { XAI_API_KEY: 'unused' },
        model: 'unused',
      }),
  },
}

/** How `kind`'s CLI is installed, which an image or a machine bakes ahead of a session. */
export function setupOf(kind: AgentKind): HarnessSetup {
  const entry: HarnessCatalogEntry = HARNESSES[kind]
  const install = INSTALLS[kind]
  return {
    name: entry.name,
    ...install,
    recipe: async () => (await install.adapter()).getBootstrap?.({}),
    credentials: [
      ...(entry.credential ? [entry.credential] : []),
      ...(entry.fallbackCredentials ?? []),
    ],
    platforms: entry.platforms,
  }
}

/** The AI SDK's bootstrap state directory, under `home`. */
const stateDirectory = (home: string) => posix.join(home, '.ai-sdk-harness')

/** The identity the AI SDK gives `recipe`, which names the marker it writes once it ran. */
export async function recipeIdentity(recipe: HarnessV1Bootstrap): Promise<string> {
  const strings = [
    stateDirectory('$HOME'),
    recipe.harnessId,
    recipe.bootstrapDir,
    ...[...recipe.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .flatMap((f) => [f.path, f.content]),
    JSON.stringify(recipe.commands),
    '1',
  ]
  const bytes = new TextEncoder().encode(strings.map((s) => `${s}\0`).join(''))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Where the AI SDK marks `recipe` installed, for a user whose home is `home`. */
export async function recipeMarker(recipe: HarnessV1Bootstrap, home: string): Promise<string> {
  const dir = posix.resolve(stateDirectory(home), recipe.bootstrapDir)
  return posix.join(dir, `.bootstrap-${await recipeIdentity(recipe)}.ok`)
}

/**
 * Installs `adapter`'s CLI on `runner` as `mode` says, before its session starts; the session
 * would otherwise install it as it starts, untimed. False when there was nothing to install.
 */
export async function installHarness(o: {
  runner: Runner
  home: string
  adapter: HarnessV1
  name: string
  mode: InstallMode
  workDir: string
  signal?: AbortSignal
}): Promise<boolean> {
  const recipe = await o.adapter.getBootstrap?.({})
  if (!recipe) return false
  const marker = await recipeMarker(recipe, o.home)
  if (o.mode === 'skip') {
    if ((await o.runner.readFile(marker)) === null) {
      throw new AgentError(
        `The runner doesn't have this build of the ${o.name} CLI installed, and install is 'skip': install it there, or use install: 'auto'`,
      )
    }
    return false
  }
  if (o.mode === 'always') {
    const removed = await o.runner.spawn(['rm', '-f', '--', marker]).exited
    if (removed.code !== 0) throw new AgentError(`Couldn't remove ${marker} to install again`)
  }
  const template = await createHarnessSandboxTemplate({
    harnesses: [o.adapter],
    sandboxConfig: { workDir: o.workDir },
  })
  await template?.prepare({
    session: await runnerSession(o.runner, { id: 'install' }),
    ...(o.signal ? { abortSignal: o.signal } : {}),
  })
  return true
}
