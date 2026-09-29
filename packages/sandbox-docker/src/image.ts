/**
 * The harness adapters an image can bake. Each pin must match the exact dependency (or
 * `workspace:<version>` for this repo's own adapters); a test enforces it. `patch` is the first 8
 * hex of the sha256 of the adapter's pnpm patch (`patchedDependencies` in pnpm-workspace.yaml),
 * whose bridge the image bakes; a test holds it to the patch file.
 */
export const HARNESS_PACKAGES: Record<
  'cursor' | 'claude-code' | 'antigravity' | 'opencode' | 'goose' | 'pi' | 'codex',
  { readonly name: string; readonly version: string; readonly patch?: string }
> = {
  cursor: { name: '@reeval/harness-cursor-sdk', version: '0.1.0' },
  'claude-code': { name: '@ai-sdk/harness-claude-code', version: '1.0.128', patch: '5d1c985c' },
  antigravity: { name: '@reeval/harness-antigravity', version: '0.1.0' },
  opencode: { name: '@reeval/harness-opencode', version: '0.2.0' },
  goose: { name: '@reeval/harness-goose', version: '0.1.0' },
  pi: { name: '@reeval/harness-pi', version: '0.2.0' },
  codex: { name: '@reeval/harness-codex', version: '0.1.0' },
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
export const BRIDGE_PORT = 43210
