/** Must match the exact `@ai-sdk/harness-cursor` dependency; a test enforces it. */
export const HARNESS_CURSOR_VERSION = '1.0.36'

export const BASE_IMAGE = 'evalsuite-sandbox-base:latest'
export const DEFAULT_IMAGE = `evalsuite-sandbox:cursor-${HARNESS_CURSOR_VERSION}`

export const LABEL = {
  managed: 'dev.evalsuite.managed',
  run: 'dev.evalsuite.run',
  /** Unique per session, so a create cut short can find what it made. */
  session: 'dev.evalsuite.session',
  agentVersion: 'dev.evalsuite.agent-version',
  harness: 'dev.evalsuite.harness',
} as const

/** The container's default working directory, as seen by the harness. */
export const SANDBOX_ROOT = '/es'
/** The agent's working directory, relative to {@link SANDBOX_ROOT}. */
export const WORKSPACE_DIR = 'workspace'
export const BRIDGE_PORT = 43210
