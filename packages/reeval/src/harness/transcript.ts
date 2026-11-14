import { normalizeStream as normalize } from '@reeval/agents'
import { SANDBOX_ROOT, WORKSPACE_DIR } from '@reeval/sandbox-docker'

/** The workspace's root, slot 0's (`/reeval/workspace/`) or a shared machine's slot's (`/reeval-s2/…`). */
export const WORKSPACE_PATH = new RegExp(`^${SANDBOX_ROOT}(?:-s\\d+)?/${WORKSPACE_DIR}/`)

/** `normalizeStream` with edit paths relative to reeval's workspace, as the driver runs it. */
export const normalizeStream = (...[parts, startedAt, options]: Parameters<typeof normalize>) =>
  normalize(parts, startedAt, { workspace: WORKSPACE_PATH, ...options })
