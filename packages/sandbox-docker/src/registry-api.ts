import { createHash } from 'node:crypto'

/** An image reference split the way the registry API addresses it. */
export type ImageRef = {
  /** The registry's API host, with its port: `registry-1.docker.io` for Docker Hub. */
  host: string
  /** The repository on it, with Docker Hub's `library/` for an official image. */
  repository: string
  /** The tag or digest the manifest is asked for by: `latest` when the reference names neither. */
  reference: string
}

/** A registry login: a user and password (or token as password), or a bearer token as is. */
export type RegistryCredential = { username: string; password: string } | { token: string }

export type RegistryDigestOptions = {
  signal?: AbortSignal | undefined
  /** The login for a registry host (as {@link ImageRef.host} names it), or none for anonymous pulls. */
  credential?: ((host: string) => RegistryCredential | undefined) | undefined
  /** The `fetch` to use. */
  fetch?: typeof fetch | undefined
  /** How long one lookup may take, in ms. */
  timeoutMs?: number | undefined
}

const DIGEST = /^sha256:[0-9a-f]{64}$/

/**
 * The manifest types asked for, an index first: the digest is then the top-level manifest's, as
 * `docker buildx imagetools inspect` reports it and as `fromImageKey` keys a `from` image.
 */
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/**
 * `ref` as the registry API addresses it, normalized as Docker does: no registry is Docker Hub, a
 * one-part Docker Hub name is under `library/`, and no tag is `latest`. Null when it isn't a
 * reference.
 */
export function parseImageRef(ref: string): ImageRef | null {
  const at = ref.indexOf('@')
  const digest = at === -1 ? null : ref.slice(at + 1)
  if (digest !== null && !DIGEST.test(digest)) return null
  let name = at === -1 ? ref : ref.slice(0, at)
  const slash = name.indexOf('/')
  const first = slash === -1 ? '' : name.slice(0, slash)
  let host = 'docker.io'
  if (first && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    host = first
    name = name.slice(slash + 1)
  }
  const colon = name.lastIndexOf(':')
  const tag = colon === -1 ? null : name.slice(colon + 1)
  if (colon !== -1) name = name.slice(0, colon)
  if (tag !== null && !/^[\w][\w.-]{0,127}$/.test(tag)) return null
  if (
    !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(
      name,
    )
  ) {
    return null
  }
  if (host === 'docker.io' || host === 'index.docker.io') {
    host = 'registry-1.docker.io'
    if (!name.includes('/')) name = `library/${name}`
  }
  return { host, repository: name, reference: digest ?? tag ?? 'latest' }
}

/** A loopback registry speaks plain HTTP, as Docker allows without an insecure-registries entry. */
const scheme = (host: string) =>
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https'

/** The parameters of a `WWW-Authenticate` challenge: its scheme, lowercase, and its fields. */
function challenge(header: string | null): { scheme: string; params: Record<string, string> } {
  const match = /^\s*(\w+)\s*(.*)$/s.exec(header ?? '')
  const params: Record<string, string> = {}
  for (const [, key, quoted, bare] of (match?.[2] ?? '').matchAll(
    /(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g,
  )) {
    if (key) params[key.toLowerCase()] = quoted?.replace(/\\(.)/g, '$1') ?? bare ?? ''
  }
  return { scheme: match?.[1]?.toLowerCase() ?? '', params }
}

const basic = (c: { username: string; password: string }) =>
  `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`

/**
 * What `ref` names in its registry now, without Docker: the digest of its top-level manifest (an
 * index for a multi-platform image), through the registry HTTP API. It follows the registry's
 * token challenge, anonymously or with `credential`'s login. A reference pinned by digest is that
 * digest. `error` when it doesn't resolve: no such image, access refused or no network.
 */
export async function registryDigest(
  ref: string,
  options: RegistryDigestOptions = {},
): Promise<{ digest: string } | { error: string }> {
  const parsed = parseImageRef(ref)
  if (!parsed) return { error: `${ref} isn't an image reference` }
  if (DIGEST.test(parsed.reference)) return { digest: parsed.reference }
  const { host, repository, reference } = parsed
  const fetchFn = options.fetch ?? fetch
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 15_000),
    ...(options.signal ? [options.signal] : []),
  ])
  const login = options.credential?.(host)
  const url = `${scheme(host)}://${host}/v2/${repository}/manifests/${encodeURIComponent(reference)}`
  const ask = (method: 'HEAD' | 'GET', authorization: string | null) =>
    fetchFn(url, {
      method,
      headers: { accept: ACCEPT, ...(authorization ? { authorization } : {}) },
      signal,
    })
  try {
    let authorization: string | null = login && 'token' in login ? `Bearer ${login.token}` : null
    let response = await ask('HEAD', authorization)
    if (response.status === 401 && !(login && 'token' in login)) {
      const asked = challenge(response.headers.get('www-authenticate'))
      if (asked.scheme === 'bearer' && asked.params.realm) {
        const token = await bearerToken(asked.params, repository, login, fetchFn, signal)
        if ('error' in token)
          return { error: `${host} refused a token for ${repository}: ${token.error}` }
        authorization = `Bearer ${token.token}`
      } else if (asked.scheme === 'basic' && login) {
        authorization = basic(login)
      }
      if (authorization) response = await ask('HEAD', authorization)
    }
    if (response.ok) {
      const said = response.headers.get('docker-content-digest')
      if (said && DIGEST.test(said)) return { digest: said }
      // A registry that leaves the header off a HEAD: the digest is the manifest's own hash.
      const body = await ask('GET', authorization)
      if (body.ok) {
        const bytes = Buffer.from(await body.arrayBuffer())
        return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
      }
      response = body
    }
    if (response.status === 401 || response.status === 403) {
      return {
        error: `${host} refused ${repository} (${response.status}): it doesn't exist, or it's private and needs a registry login`,
      }
    }
    if (response.status === 404) return { error: `${ref} isn't in ${host}` }
    return { error: `${host} answered ${response.status} for ${ref}` }
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    const message =
      cause instanceof Error
        ? cause.cause instanceof Error
          ? cause.cause.message
          : cause.message
        : String(cause)
    return { error: `couldn't reach ${host}: ${message}` }
  }
}

async function bearerToken(
  params: Record<string, string>,
  repository: string,
  login: RegistryCredential | undefined,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<{ token: string } | { error: string }> {
  const url = new URL(params.realm as string)
  if (params.service) url.searchParams.set('service', params.service)
  url.searchParams.set('scope', params.scope ?? `repository:${repository}:pull`)
  const response = await fetchFn(url, {
    headers: login && 'username' in login ? { authorization: basic(login) } : {},
    signal,
  })
  if (!response.ok) return { error: `${response.status}` }
  const body = (await response.json().catch(() => null)) as {
    token?: unknown
    access_token?: unknown
  } | null
  const token = body?.token ?? body?.access_token
  return typeof token === 'string' && token ? { token } : { error: 'no token in the answer' }
}
