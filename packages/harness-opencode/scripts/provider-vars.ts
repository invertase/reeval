// Variables a provider needs besides its key, which aren't secret and go into the sandbox as they
// are. The probe sets each to `probe`, so a host built from it is recognizable, and the table has
// the host with `{NAME}` in its place, filled in from the host's value (or `default`) at run time.

export type ProviderVar = {
  readonly name: string
  /** The value the probe runs with. */
  readonly probe: string
  /** The value when the host doesn't set it: OpenCode's own default. */
  readonly default: string
  /** What a value must look like, since it goes into a host name. */
  readonly pattern: string
}

export const PROVIDER_VARS: Record<string, readonly ProviderVar[]> = {
  // OpenCode builds Bedrock's hosts from the region: bedrock-runtime.<region>.amazonaws.com, and
  // bedrock-mantle.<region>.api.aws for its OpenAI-compatible models.
  'amazon-bedrock': [
    {
      name: 'AWS_REGION',
      probe: 'eu-south-2',
      default: 'us-east-1',
      pattern: '^[a-z]{2}(-[a-z]+)+-\\d{1,2}$',
    },
  ],
}
