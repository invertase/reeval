import { adapterForFile } from './adapter.ts'

/** Loads an eval file through its language adapter while the worker is collecting. */
export const loadEvalModule = (file: string, root: string): Promise<unknown> =>
  adapterForFile(file).load(file, root)
