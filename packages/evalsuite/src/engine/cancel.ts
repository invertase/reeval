import { join } from 'node:path'

/**
 * Written into the run's staging dir when the run is cancelled. A worker only listens for
 * Vitest's cancel once it starts a file, so a cancel sent while it boots is lost without this.
 */
export const cancelMarker = (stagingDir: string) => join(stagingDir, 'cancelled')

/** Written when the run's duration budget is reached: queued attempts skip instead of starting. */
export const budgetMarker = (stagingDir: string) => join(stagingDir, 'budget-reached')
