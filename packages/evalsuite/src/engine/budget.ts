import { join } from 'node:path'

/** Written when the run's duration budget is reached: queued attempts skip instead of starting. */
export const budgetMarker = (stagingDir: string) => join(stagingDir, 'budget-reached')
