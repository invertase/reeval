import type { HarnessAgentAdapter } from '@ai-sdk/harness/agent'

/**
 * How a harness's CLI gets into a machine: Docker's images, Tart's baked images and `boat()`'s VMs
 * all run its adapter's bootstrap. The caller has it, from `@reeval/agents`' `setupOf`.
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
 * The harness adapters an image can bake. Each pin must match `@reeval/agents`' exact dependency
 * (or `workspace:<version>` for this repo's own adapters), whose bootstrap the image bakes; a test
 * enforces it. `patch` is the first 8 hex of the sha256 of the adapter's pnpm patch
 * (`patchedDependencies` in pnpm-workspace.yaml), whose bridge the image bakes; a test holds it to
 * the patch file.
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
  }
> = {
  cursor: {
    name: '@reeval/harness-cursor-sdk',
    version: '0.1.9',
  },
  'claude-code': {
    name: '@ai-sdk/harness-claude-code',
    version: '1.0.176',
    patch: 'a9d56a8c',
  },
  antigravity: {
    name: '@reeval/harness-antigravity',
    version: '0.1.17',
  },
  opencode: {
    name: '@reeval/harness-opencode',
    version: '0.2.16',
  },
  goose: {
    name: '@reeval/harness-goose',
    version: '0.1.17',
  },
  pi: {
    name: '@reeval/harness-pi',
    version: '0.2.10',
  },
  codex: {
    name: '@reeval/harness-codex',
    version: '0.1.14',
  },
  fx: {
    name: '@reeval/harness-fx',
    version: '0.1.14',
  },
  'grok-build': {
    name: '@reeval/harness-grok-build',
    version: '0.1.13',
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
  /**
   * On every session's containers: `<pid>@<host>` of the process that created them, so a later
   * reeval on that host can remove the ones a killed process left behind.
   */
  owner: 'ai.reeval.owner',
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
/** Below 32768, so no ephemeral port on a Linux machine (32768–60999) can hold it. */
export const BRIDGE_PORT = 24210

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

/** The egress forwarder's port for slot 0; slot `n` listens on this plus `n`, below Linux's
 * ephemeral range (32768–60999) like {@link BRIDGE_PORT}.
 */
export const BASE_PROXY_PORT = 24128

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
