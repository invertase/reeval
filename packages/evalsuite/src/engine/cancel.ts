import { join } from 'node:path'

/**
 * Written into the run's staging dir when the run is cancelled. A worker only listens for
 * Vitest's cancel once it starts a file, so a cancel sent while it boots is lost without this.
 */
export const cancelMarker = (stagingDir: string) => join(stagingDir, 'cancelled')
