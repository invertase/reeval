// Where a routing gateway's APIs are, as data its routes and its adapter providers both read.

/**
 * Where a gateway's APIs are: its routes broker its key on these, and every adapter provider for
 * it points at them (`test/gateway.test.ts` holds each adapter's to them).
 */
export type GatewayApi = {
  /** `https://openrouter.ai`: the origin its key is brokered on. */
  origin: string
  /** Its OpenAI-compatible API's base URL, for Chat Completions, Responses and the model list. */
  openai: string
  /** Its Anthropic Messages API's base URL, as `ANTHROPIC_BASE_URL` takes it. */
  anthropic: string
}

/** The host `api`'s key is brokered on. */
export const apiHost = (api: GatewayApi): string => new URL(api.origin).hostname

const under = (base: string, endpoint: string) =>
  `${new URL(base).pathname.replace(/\/$/, '')}${endpoint}`

/** The path of `endpoint` (`/chat/completions`) on `api`'s OpenAI-compatible API. */
export const openaiPath = (api: GatewayApi, endpoint: string): string => under(api.openai, endpoint)

/** The path of `endpoint` (`/v1/messages`) on `api`'s Anthropic Messages API. */
export const anthropicPath = (api: GatewayApi, endpoint: string): string =>
  under(api.anthropic, endpoint)
