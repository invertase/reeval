// `reeval/sandbox/boat`: boat.dev VMs as sandboxes. This module only describes them; the Boat SDK
// (`@boatdev/sdk`, an optional peer) loads in the worker that creates one.
import { existsSync, statSync } from 'node:fs'
import {
  type BoatOptions,
  type CreateBoatOptions,
  checkBoatOptions,
  checkCreateBoatOptions,
} from './contract/boat.ts'
import { callerDir, toPath } from './environment.ts'
import { UsageError } from './errors.ts'
import type { BoatSandboxDescriptor } from './types.ts'

export type { BoatOptions, CreateBoatOptions } from './contract/boat.ts'
export type { BoatApiKey, BoatMachineType, BoatSandboxDescriptor } from './types.ts'

const isOptions = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A `boat()` for one Boat account and name prefix: `apiKey` names the host variable with the API
 * key (`secret.fromEnv('BOAT_API_KEY')` by default), and `prefix` starts every sandbox name
 * reeval gives Boat (`reeval` by default), so a run's cleanup deletes only its own.
 */
export function createBoat(
  options: CreateBoatOptions = {},
): (options?: BoatOptions) => BoatSandboxDescriptor {
  if (!isOptions(options)) {
    throw new UsageError(`createBoat() takes an options object (got ${JSON.stringify(options)})`)
  }
  checkCreateBoatOptions(options)
  const apiKey = { kind: 'secret' as const, from: options.apiKey?.from ?? 'BOAT_API_KEY' }
  const prefix = options.prefix ?? 'reeval'
  return (sandbox: BoatOptions = {}) => {
    if (!isOptions(sandbox)) {
      throw new UsageError(`boat() takes an options object (got ${JSON.stringify(sandbox)})`)
    }
    checkBoatOptions(sandbox)
    const { dockerfile, ...rest } = sandbox
    const descriptor: BoatSandboxDescriptor = {
      kind: 'boat',
      apiKey,
      prefix,
      ...structuredClone(rest),
    }
    if (dockerfile !== undefined) {
      const full = toPath(dockerfile, callerDir() ?? process.cwd())
      if (!existsSync(full) || !statSync(full).isFile()) {
        throw new UsageError(
          `boat({ dockerfile: ${JSON.stringify(String(dockerfile))} }): ${full} doesn't exist. Paths are relative to the file that calls boat().`,
        )
      }
      descriptor.dockerfile = full
    }
    return descriptor
  }
}

/**
 * One boat.dev VM per attempt, on the account whose key is in `BOAT_API_KEY`. The agent, setup
 * steps and checks run as an unprivileged user over SSH; credentials stay on the host behind the
 * egress gateway, as in Docker. Needs `npm i @boatdev/sdk`, and `egress: 'allow-all'` unless the
 * sandbox has an image recipe.
 *
 * With `image`, `from`, `dockerfile` or `install` (as `docker()` takes them), preflight builds the
 * image once into a Boat saved snapshot, and each attempt runs in a container of the image on a VM
 * started from it, where every egress policy is enforced.
 */
export const boat = createBoat()
