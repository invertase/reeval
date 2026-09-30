import type {
  HarnessV1AuthenticationEnvironment,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness'
import {
  createCredentialRequestTransformation,
  isHarnessAuthenticationEnvironment,
} from '@ai-sdk/harness/utils'

/** The only credential the adapter uses: a Gemini API key, for the CLI's `gemini` provider. */
export const ANTIGRAVITY_CREDENTIAL_ENV = 'GEMINI_API_KEY'
/** Overrides where the CLI sends Gemini API requests (and so where the key is brokered). */
export const ANTIGRAVITY_BASE_URL_ENV = 'GOOGLE_GEMINI_BASE_URL'
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com'
/** The header the CLI sends the key in. It never puts the key in the query string. */
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key'

/**
 * `'auto'` reads `GEMINI_API_KEY` (and `GOOGLE_GEMINI_BASE_URL`) from the host. An environment
 * object uses only what it holds. Google-account sign-in is never used: automating the CLI's
 * OAuth session from another tool risks the account under Google's terms.
 */
export type AntigravityAuthentication = 'auto' | HarnessV1AuthenticationEnvironment

export type AntigravityCredentials = {
  apiKey: string
  /** Set only when the environment overrides the Gemini API base URL. */
  baseUrl?: string
}

export function resolveAntigravityCredentials(
  auth: AntigravityAuthentication = 'auto',
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): AntigravityCredentials {
  if (auth !== 'auto' && !isHarnessAuthenticationEnvironment(auth)) {
    throw new Error(
      `Antigravity auth must be 'auto' or an environment object such as { ${ANTIGRAVITY_CREDENTIAL_ENV}: '…' } (got ${JSON.stringify(auth)})`,
    )
  }
  const env = auth === 'auto' ? hostEnv : auth
  const apiKey = env[ANTIGRAVITY_CREDENTIAL_ENV]
  if (!apiKey) {
    throw new Error(
      `${ANTIGRAVITY_CREDENTIAL_ENV} isn't set, so the Antigravity CLI can't authenticate. It needs a Gemini API key (Google AI Studio).`,
    )
  }
  const baseUrl = env[ANTIGRAVITY_BASE_URL_ENV]
  return { apiKey, ...(baseUrl ? { baseUrl } : {}) }
}

/**
 * The model-request endpoint the CLI sends the key on: `POST /v1beta/models/<model>:
 * streamGenerateContent` (checked with CLI 1.2.14; it also calls a lite model for titles and
 * checkpoints). Pass it as a gateway's endpoint allowlist to refuse the key anywhere else.
 */
export function antigravityEndpoints(baseUrl: string = GEMINI_API_URL) {
  const url = new URL(baseUrl)
  const prefix = url.pathname.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    {
      host: url.hostname,
      path: { regex: `^${prefix}/v1beta/models/[^/]+:streamGenerateContent$` },
      method: ['POST'],
    },
  ] as const satisfies ReadonlyArray<
    Pick<HarnessV1RequestTransformation['match'], 'host' | 'path' | 'method'>
  >
}

/**
 * Swaps the sandbox's placeholder for the real key on requests to the Gemini API's host (under
 * the base URL's path, when it has one). The rule is host-wide on purpose: a gateway that also
 * enforces {@link antigravityEndpoints} can then refuse, loudly, a placeholder sent anywhere else.
 */
export function createAntigravityRequestTransformations({
  credentials,
  placeholder,
  headers,
}: {
  credentials: AntigravityCredentials
  placeholder: string
  /** Extra headers for model requests, e.g. from `HarnessV1StartOptions.headers`. */
  headers?: Readonly<Record<string, string>>
}): HarnessV1RequestTransformation[] {
  return [
    createCredentialRequestTransformation({
      matchUrl: credentials.baseUrl ?? GEMINI_API_URL,
      matchHeaders: { [GEMINI_API_KEY_HEADER]: placeholder },
      transformHeaders: { ...headers, [GEMINI_API_KEY_HEADER]: credentials.apiKey },
    }),
  ]
}
