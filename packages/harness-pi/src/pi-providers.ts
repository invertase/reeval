import { PI_PROVIDERS, PI_REFUSED_PROVIDERS } from './pi-provider-table.ts'

/** A header pi sends a provider's key in: `scheme` set when its value is `<scheme> <key>`. */
export type PiKeyHeader = { readonly name: string; readonly scheme?: string }

/** A request pi sends the key on, with the headers that carry it. */
export type PiEndpoint = {
  readonly host: string
  readonly method: readonly string[]
  readonly path: { readonly exact: string } | { readonly regex: string }
  /** pi's API for it, e.g. `openai-completions`; `google-generative-ai` names its model in the path. */
  readonly api: string
  readonly headers: readonly PiKeyHeader[]
}

/** A provider pi calls with its own key (`--provider`): the variable pi reads it from, and where it sends it. */
export type PiProvider = {
  /** The pi provider id, `--provider`. */
  readonly id: string
  readonly credentialEnv: string
  readonly endpoints: readonly PiEndpoint[]
}

/** A provider of pi's that reeval can't broker a key for, and why. */
export type RefusedPiProvider = { readonly id: string; readonly reason: string }

/** pi's provider `id`, or why reeval can't run it on its own key. */
export function piProvider(id: string): PiProvider | { refused: string } {
  const provider = PI_PROVIDERS.find((p) => p.id === id)
  if (provider) return provider
  const refused = PI_REFUSED_PROVIDERS.find((p) => p.id === id)
  return {
    refused: refused
      ? `pi's ${id} provider can't run here: ${refused.reason}`
      : `pi has no provider ${JSON.stringify(id)} that reads a key`,
  }
}
