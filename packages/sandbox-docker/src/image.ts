/** The harness adapters an image can bake. Each pin must match the exact dependency; a test enforces it. */
export const HARNESS_PACKAGES = {
  cursor: { name: '@ai-sdk/harness-cursor', version: '1.0.37' },
  'claude-code': { name: '@ai-sdk/harness-claude-code', version: '1.0.128' },
} as const

/** A harness whose CLI an image can bake. */
export type BakedHarness = keyof typeof HARNESS_PACKAGES
/** Every harness with an image, in {@link HARNESS_PACKAGES} order. */
export const BAKED_HARNESSES = Object.keys(HARNESS_PACKAGES) as BakedHarness[]
/** Whether `kind` names a harness with an image. */
export const isBakedHarness = (kind: string): kind is BakedHarness =>
  Object.hasOwn(HARNESS_PACKAGES, kind)

export const BASE_IMAGE = 'evalsuite-sandbox-base:latest'
/** The image `es image build <harness>` makes; the tag pins the adapter, whose bootstrap pins the CLI. */
export const imageFor = (harness: BakedHarness) =>
  `evalsuite-sandbox:${harness}-${HARNESS_PACKAGES[harness].version}`
/** The default harness's image, which the fake harness also runs in. */
export const DEFAULT_IMAGE = imageFor('cursor')

export const LABEL = {
  managed: 'dev.evalsuite.managed',
  run: 'dev.evalsuite.run',
  agentVersion: 'dev.evalsuite.agent-version',
  harness: 'dev.evalsuite.harness',
} as const

/** The container's default working directory, as seen by the harness. */
export const SANDBOX_ROOT = '/es'
/** The agent's working directory, relative to {@link SANDBOX_ROOT}. */
export const WORKSPACE_DIR = 'workspace'
export const BRIDGE_PORT = 43210
