// `reeval/sandbox/daytona`: Daytona sandboxes. This module only describes them; Daytona's SDK
// (`@daytona/sdk`, an optional peer) loads in the run's main process, which starts them.
import {
  type CreateDaytonaOptions,
  checkCreateDaytonaOptions,
  checkDaytonaOptions,
  type DaytonaOptions,
} from './contract/daytona.ts'
import { UsageError } from './errors.ts'
import type { DaytonaSandboxDescriptor } from './types.ts'

export type { CreateDaytonaOptions, DaytonaOptions } from './contract/daytona.ts'
export type { DaytonaApiKey, DaytonaSandboxDescriptor, DaytonaSize } from './types.ts'

const isOptions = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A `daytona()` for one Daytona organization and name prefix: `apiKey` names the host variable
 * with the API key (`secret.fromEnv('DAYTONA_API_KEY')` by default), and `prefix` starts every
 * sandbox name reeval gives Daytona (`reeval` by default), so a run's cleanup deletes only its own.
 */
export function createDaytona(
  options: CreateDaytonaOptions = {},
): (options?: DaytonaOptions) => DaytonaSandboxDescriptor {
  if (!isOptions(options)) {
    throw new UsageError(`createDaytona() takes an options object (got ${JSON.stringify(options)})`)
  }
  checkCreateDaytonaOptions(options)
  const apiKey = { kind: 'secret' as const, from: options.apiKey?.from ?? 'DAYTONA_API_KEY' }
  const prefix = options.prefix ?? 'reeval'
  return (sandbox: DaytonaOptions = {}) => {
    if (!isOptions(sandbox)) {
      throw new UsageError(`daytona() takes an options object (got ${JSON.stringify(sandbox)})`)
    }
    checkDaytonaOptions(sandbox)
    return { kind: 'daytona', apiKey, prefix, ...structuredClone(sandbox) }
  }
}

/**
 * One Daytona sandbox per attempt, on the organization whose key is in `DAYTONA_API_KEY`. The
 * agent, setup steps and checks run as an unprivileged user over Daytona's SSH gateway;
 * credentials stay on the host behind the egress gateway, as in Docker. Needs
 * `npm i @daytona/sdk` and `egress: 'allow-all'`.
 */
export const daytona = createDaytona()
