import type { ProviderStop, ProviderStopRecord } from '@reeval/agents'
import { InfraError } from '../sandbox/types.ts'

/** A turn the provider stopped, as the infra error that fails the attempt. */
export class ProviderStopError extends InfraError {
  readonly stop: ProviderStopRecord
  constructor({ message, ...stop }: ProviderStop) {
    super(message)
    this.stop = stop
  }
}
