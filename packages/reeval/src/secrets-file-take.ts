// Kept apart from secrets-file.ts so `bin.ts` can take the file before it loads the rest of reeval:
// a failure loading a module mustn't leave the values on disk.
import { readFileSync, rmSync } from 'node:fs'

export const SECRETS_FILE_VAR = 'REEVAL_SECRETS_FILE'

type Taken = { file: string; text: string } | { file: string; error: string }
let taken: Taken | undefined

/** Reads and deletes the file `REEVAL_SECRETS_FILE` names, once, and unsets the variable. */
export function takeSecretsFile(env: NodeJS.ProcessEnv = process.env): Taken | undefined {
  const file = env[SECRETS_FILE_VAR]
  delete env[SECRETS_FILE_VAR]
  if (!file) return taken
  try {
    taken = { file, text: readFileSync(file, 'utf8') }
  } catch (error) {
    taken = { file, error: (error as Error).message }
  } finally {
    rmSync(file, { force: true })
  }
  return taken
}

/** What `takeSecretsFile` read, handed over once: the values go nowhere else. */
export function claimSecretsFile(env: NodeJS.ProcessEnv = process.env): Taken | undefined {
  const claimed = takeSecretsFile(env)
  taken = undefined
  return claimed
}
