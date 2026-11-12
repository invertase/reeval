import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'

/**
 * How a harness's CLI gets into a machine: Docker's images, Tart's baked images and `boat()`'s VMs
 * all run its adapter's bootstrap.
 */
export type HarnessBootstrap = {
  /** How progress and errors name the harness. */
  readonly name: string
  /** The binary the bootstrap leaves under `~/.ai-sdk-harness`, or the package it installs. */
  readonly cli: string
  /** For an adapter that leaves no binary: a command that prints what it installed. */
  readonly probe?: string
  /** The adapter, with placeholder auth: only its bootstrap is read. */
  readonly adapter: () => Promise<HarnessAgentAdapter>
}

/**
 * The harness adapters an image can bake, and each one's bootstrap. Each pin must match the exact
 * dependency (or `workspace:<version>` for this repo's own adapters); a test enforces it. `patch`
 * is the first 8 hex of the sha256 of the adapter's pnpm patch (`patchedDependencies` in
 * pnpm-workspace.yaml), whose bridge the image bakes; a test holds it to the patch file.
 */
export const HARNESS_PACKAGES: Record<
  | 'cursor'
  | 'claude-code'
  | 'antigravity'
  | 'opencode'
  | 'goose'
  | 'pi'
  | 'codex'
  | 'fx'
  | 'grok-build',
  {
    readonly name: string
    readonly version: string
    readonly patch?: string
    readonly bootstrap: HarnessBootstrap
  }
> = {
  cursor: {
    name: '@reeval/harness-cursor-sdk',
    version: '0.1.9',
    bootstrap: {
      name: 'Cursor',
      cli: '@cursor/sdk',
      probe: `node -p "'@cursor/sdk ' + require(process.env.HOME + '/.ai-sdk-harness/.harness-bootstrap/cursor-sdk/node_modules/@cursor/sdk/package.json').version"`,
      adapter: async () => (await import('@reeval/harness-cursor-sdk')).createCursorSdk(),
    },
  },
  'claude-code': {
    name: '@ai-sdk/harness-claude-code',
    version: '1.0.176',
    patch: 'a9d56a8c',
    bootstrap: {
      name: 'Claude Code',
      cli: 'claude',
      adapter: async () => (await import('@ai-sdk/harness-claude-code')).createClaudeCode(),
    },
  },
  antigravity: {
    name: '@reeval/harness-antigravity',
    version: '0.1.17',
    bootstrap: {
      name: 'Antigravity',
      cli: 'agy',
      adapter: async () => (await import('@reeval/harness-antigravity')).createAntigravity(),
    },
  },
  opencode: {
    name: '@reeval/harness-opencode',
    version: '0.2.16',
    bootstrap: {
      name: 'OpenCode',
      cli: 'opencode',
      adapter: async () =>
        (await import('@reeval/harness-opencode')).createOpenCode({
          auth: { GOOGLE_GENERATIVE_AI_API_KEY: 'unused' },
          model: 'google/unused',
        }),
    },
  },
  goose: {
    name: '@reeval/harness-goose',
    version: '0.1.17',
    bootstrap: {
      name: 'Goose',
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
  },
  pi: {
    name: '@reeval/harness-pi',
    version: '0.2.9',
    bootstrap: {
      name: 'pi',
      cli: 'pi',
      adapter: async () => {
        const pi = await import('@reeval/harness-pi')
        const provider = pi.piProvider('google')
        if ('refused' in provider) throw new Error(provider.refused)
        return pi.createPi({ auth: { GEMINI_API_KEY: 'unused' }, provider })
      },
    },
  },
  codex: {
    name: '@reeval/harness-codex',
    version: '0.1.14',
    bootstrap: {
      name: 'Codex',
      cli: 'codex',
      adapter: async () =>
        (await import('@reeval/harness-codex')).createCodex({ auth: { OPENAI_API_KEY: 'unused' } }),
    },
  },
  fx: {
    name: '@reeval/harness-fx',
    version: '0.1.12',
    bootstrap: {
      name: 'fx',
      cli: 'fx',
      adapter: async () =>
        (await import('@reeval/harness-fx')).createFx({
          auth: { AI_GATEWAY_API_KEY: 'unused' },
          model: 'unused/unused',
        }),
    },
  },
  'grok-build': {
    name: '@reeval/harness-grok-build',
    version: '0.1.13',
    bootstrap: {
      name: 'Grok Build',
      cli: 'grok',
      adapter: async () =>
        (await import('@reeval/harness-grok-build')).createGrokBuild({
          auth: { XAI_API_KEY: 'unused' },
          model: 'unused',
        }),
    },
  },
}

/** A harness whose CLI an image can bake. */
export type BakedHarness = keyof typeof HARNESS_PACKAGES
/** Every harness with an image, in {@link HARNESS_PACKAGES} order. */
export const BAKED_HARNESSES = Object.keys(HARNESS_PACKAGES) as BakedHarness[]
export const isBakedHarness = (kind: string): kind is BakedHarness =>
  Object.hasOwn(HARNESS_PACKAGES, kind)

/** The adapter build reeval runs for a harness: its version, and its patch if reeval patches it. */
export const adapterVersion = (harness: BakedHarness) => {
  const { version, patch } = HARNESS_PACKAGES[harness]
  return patch ? `${version}-patch.${patch}` : version
}

export const BASE_IMAGE = 'reeval-sandbox-base:latest'
/** reeval's image for a harness; the tag pins the adapter, whose bootstrap pins the CLI. */
export const imageFor = (harness: BakedHarness) =>
  `reeval-sandbox:${harness}-${adapterVersion(harness)}`
/** Cursor's image, which the fake harness also runs in by default. */
export const DEFAULT_IMAGE = imageFor('cursor')
/** The `ai.reeval.harness` label value an image baked for `harness` carries. */
export const harnessLabel = (harness: BakedHarness) =>
  `${HARNESS_PACKAGES[harness].name}@${adapterVersion(harness)}`

export const LABEL = {
  managed: 'ai.reeval.managed',
  run: 'ai.reeval.run',
  /** Unique per session, so a create cut short can find what it made. */
  session: 'ai.reeval.session',
  agentVersion: 'ai.reeval.agent-version',
  harness: 'ai.reeval.harness',
  /** On reeval's own images: the hash of the base image's build context, to tell a stale one. */
  context: 'ai.reeval.context',
  /** On a `from` image: the digest (or, for a local-only base, the image id) it was built on. */
  fromDigest: 'ai.reeval.from-digest',
  /** On every image reeval builds: its content key, which a registry pull must match. */
  key: 'ai.reeval.key',
} as const

/**
 * The user the agent, setup steps and checks run as, which every image reeval builds creates. Image
 * builds (`install`, Dockerfiles) stay root.
 */
export const SANDBOX_USER = 'reeval'
/** {@link SANDBOX_USER}'s home. */
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`

/** The container's default working directory, as seen by the harness. */
export const SANDBOX_ROOT = '/reeval'
/** The agent's working directory, relative to {@link SANDBOX_ROOT}. */
export const WORKSPACE_DIR = 'workspace'
/**
 * reeval's own state in the container, root's and mode 0700: outside {@link SANDBOX_ROOT}, which
 * {@link SANDBOX_USER} owns and so could rename it away and put its own in its place.
 */
export const SANDBOX_STATE = '/var/lib/reeval'
export const BRIDGE_PORT = 43210

/**
 * Where one attempt lives on a Linux machine that runs several at once: its own user, home,
 * working root, state directory and egress proxy port. Slot 0 is the layout every container has.
 */
export type SlotLayout = {
  user: string
  /**
   * Where the slot's home is on the machine. Its commands see it at {@link SANDBOX_HOME}, bound
   * there in a mount namespace of their own when it's elsewhere.
   */
  home: string
  root: string
  state: string
  /** The egress forwarder's port in the machine. */
  proxyPort: number
}

/** The egress forwarder's port for slot 0; slot `n` listens on this plus `n`. */
export const BASE_PROXY_PORT = 43128

/** Slot `slot`'s layout: slot 0's is {@link SANDBOX_USER}'s, `n` is `reeval-s<n>` in each place. */
export function slotLayout(slot: number): SlotLayout {
  if (slot === 0) {
    return {
      user: SANDBOX_USER,
      home: SANDBOX_HOME,
      root: SANDBOX_ROOT,
      state: SANDBOX_STATE,
      proxyPort: BASE_PROXY_PORT,
    }
  }
  const user = `${SANDBOX_USER}-s${slot}`
  return {
    user,
    home: `/home/${user}`,
    root: `${SANDBOX_ROOT}-s${slot}`,
    state: `${SANDBOX_STATE}-s${slot}`,
    proxyPort: BASE_PROXY_PORT + slot,
  }
}
