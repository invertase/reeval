// `history` and a profile's `history` checked and resolved: which store, the folder every history
// command reads, and which attempts keep their artifacts. A remote store's folder is its copy in
// `.reeval/store/<id>/history`, laid out as a history folder, so every reader stays one of files.
import { join, resolve } from 'node:path'
import { closest, oneOf } from '../contract/shared.ts'
import { UsageError } from '../errors.ts'
import type { ArtifactLevel } from '../history/types.ts'
import { sha256 } from '../ids.ts'
import { isObjectLike } from '../object.ts'
import type {
  HistoryConfig,
  LocalStoreDescriptor,
  ResolvedHistory,
  S3StoreDescriptor,
} from '../types.ts'

const ARTIFACTS = ['all', 'failures', 'none'] as const
const HISTORY_KEYS = ['store', 'artifacts', 'debug']
const DEBUG = ['none', 'requests', 'all'] as const
const LOCAL_KEYS = ['kind', 'dir']
const S3_KEYS = ['kind', 'bucket', 'endpoint', 'region', 'prefix', 'env']
const ENV_KEYS = ['accessKeyId', 'secretAccessKey', 'sessionToken', 'endpoint', 'bucket', 'region']
export const S3_ENV_DEFAULTS = {
  accessKeyId: 'AWS_ACCESS_KEY_ID',
  secretAccessKey: 'AWS_SECRET_ACCESS_KEY',
  sessionToken: 'AWS_SESSION_TOKEN',
} as const
/** Keys that would put a credential in the config, which `s3()` reads from the environment only. */
const CREDENTIALS: Record<string, keyof typeof S3_ENV_DEFAULTS> = {
  accessKeyId: 'accessKeyId',
  secretAccessKey: 'secretAccessKey',
  sessionToken: 'sessionToken',
  credentials: 'accessKeyId',
  accessKey: 'accessKeyId',
  secretKey: 'secretAccessKey',
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The `.reeval/store/<id>/` directory a remote store's copy and state live in. */
export const storeStateDir = (root: string, id: string) => join(root, '.reeval', 'store', id)

const STORE_EXAMPLE = "local(), or s3({ bucket: 'my-runs' }) from reeval/store/s3"

/** What a value that isn't a store is, for the refusal: an object without a `kind` by its keys. */
const describe = (value: unknown) =>
  isObjectLike(value) && !Array.isArray(value)
    ? `an object with ${Object.keys(value).join(', ') || 'no keys'} and no kind`
    : JSON.stringify(value)

function unknownKey(value: object, allowed: string[], where: string, file: string) {
  const key = Object.keys(value).find((k) => !allowed.includes(k))
  if (key === undefined) return
  const near = closest(key, allowed)
  throw new UsageError(
    `Unknown option "${key}" in ${where} in ${file}. ${near ? `Did you mean "${near}"?` : `Use ${allowed.join(', ')}.`}`,
  )
}

const isString = (v: unknown): v is string => typeof v === 'string'

function checkString(value: unknown, field: string, file: string): void {
  if (value !== undefined && !isString(value)) {
    throw new UsageError(`${field} in ${file} must be a string (got ${JSON.stringify(value)})`)
  }
}

/** The endpoint's origin, refusing anything but an http(s) origin without credentials. */
export function checkEndpoint(value: string, field: string, file: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(
      `${field} in ${file} must be a URL like https://<account>.r2.cloudflarestorage.com (got ${JSON.stringify(value)})`,
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`${field} in ${file} must be an http:// or https:// URL (got ${value})`)
  }
  if (url.username || url.password) {
    throw new UsageError(
      `${field} in ${file} has credentials in it. Put the keys in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or the variables env names), never in the config.`,
    )
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new UsageError(
      `${field} in ${file} must be the endpoint's origin, without a path: the bucket goes in bucket (got ${value})`,
    )
  }
  return url.origin
}

function checkS3(store: Record<string, unknown>, where: string, file: string): S3StoreDescriptor {
  for (const [key, variable] of Object.entries(CREDENTIALS)) {
    if (key in store) {
      throw new UsageError(
        `${where}.${key} in ${file} would put a credential in the config. s3() reads its keys from the environment only: set ${S3_ENV_DEFAULTS[variable]}, or name another variable with env: { ${variable}: 'MY_VARIABLE' }.`,
      )
    }
  }
  unknownKey(store, S3_KEYS, where, file)
  for (const key of ['bucket', 'endpoint', 'region', 'prefix']) {
    checkString(store[key], `${where}.${key}`, file)
  }
  const env = store.env
  if (env !== undefined) {
    if (!isObjectLike(env)) {
      throw new UsageError(
        `${where}.env in ${file} must name host variables, e.g. { accessKeyId: 'R2_ACCESS_KEY_ID' } (got ${JSON.stringify(env)})`,
      )
    }
    unknownKey(env, ENV_KEYS, `${where}.env`, file)
    for (const [key, name] of Object.entries(env)) {
      if (!isString(name) || !ENV_NAME.test(name)) {
        throw new UsageError(
          `${where}.env.${key} in ${file} names a host variable, like R2_ACCESS_KEY_ID; it never holds the value itself (got ${JSON.stringify(name)})`,
        )
      }
    }
  }
  const s3 = store as S3StoreDescriptor
  if (!s3.bucket && !s3.env?.bucket) {
    throw new UsageError(
      `${where} in ${file} names no bucket. Set bucket, or env: { bucket: 'MY_BUCKET' } to read it from a host variable.`,
    )
  }
  if (s3.bucket === '') throw new UsageError(`${where}.bucket in ${file} is empty`)
  const out: S3StoreDescriptor = { ...s3 }
  if (s3.endpoint !== undefined)
    out.endpoint = checkEndpoint(s3.endpoint, `${where}.endpoint`, file)
  if (s3.prefix !== undefined) {
    const prefix = s3.prefix.replace(/^\/+|\/+$/g, '')
    if (prefix.split('/').some((part) => part === '.' || part === '..')) {
      throw new UsageError(`${where}.prefix in ${file} can't have . or .. parts (got ${s3.prefix})`)
    }
    if (prefix) out.prefix = prefix
    else delete out.prefix
  }
  return out
}

/** The store's id: keys its copy in `.reeval/store/`, from where the store is. */
function storeId(parts: unknown): string {
  return sha256(JSON.stringify(parts)).slice(0, 12)
}

/**
 * Where an `s3()` store is now: its bucket, endpoint and prefix, each variable read as `s3Settings`
 * reads it, so pointing a variable at another bucket gives another copy. A variable that isn't set
 * stays its name; `s3Settings` refuses it once the store is used.
 */
function s3Location(s3: S3StoreDescriptor, env: NodeJS.ProcessEnv = process.env) {
  const read = (name: string | undefined) => (name && env[name]) || null
  const endpoint = s3.endpoint ?? read(s3.env?.endpoint ?? 'AWS_ENDPOINT_URL_S3')
  return {
    kind: 's3',
    bucket: s3.bucket ?? read(s3.env?.bucket) ?? { env: s3.env?.bucket },
    endpoint: endpoint?.replace(/\/+$/, '') ?? {
      region:
        s3.region ??
        read(s3.env?.region) ??
        env.AWS_REGION ??
        env.AWS_DEFAULT_REGION ??
        'us-east-1',
    },
    prefix: s3.prefix ?? '',
  }
}

/** A store path that can't name a file under its run: an empty, `.` or `..` part, or a `\`. */
export const unsafePath = (path: string) =>
  path.split('/').some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))

export function s3Name(store: S3StoreDescriptor): string {
  const bucket = store.bucket ?? `$${store.env?.bucket}`
  return `s3://${bucket}${store.prefix ? `/${store.prefix}` : ''}`
}

/**
 * `history` (or a profile's, merged over `base`) checked and resolved against the config's
 * directory. `defaultDir` is the `.history` folder `local()` uses without a `dir`.
 */
export function resolveHistory(
  value: unknown,
  where: string,
  file: string,
  root: string,
  defaultDir: string,
  base?: ResolvedHistory,
): ResolvedHistory {
  const resolved = resolveStore(value, where, file, root, defaultDir, base)
  const debug = (value as HistoryConfig | undefined)?.debug ?? base?.debug ?? 'none'
  if (!DEBUG.includes(debug)) {
    throw new UsageError(
      `${where}.debug in ${file} is ${oneOf(DEBUG)} (got ${JSON.stringify(debug)})`,
    )
  }
  if (debug !== 'none' && resolved.store.kind === 'local') {
    throw new UsageError(
      `${where}.debug in ${file} uploads debug data to a remote store, and history.store is local(): .reeval/debug already holds it. Drop debug, or set it where history.store is s3().`,
    )
  }
  return { ...resolved, debug }
}

function resolveStore(
  value: unknown,
  where: string,
  file: string,
  root: string,
  defaultDir: string,
  base?: ResolvedHistory,
): Omit<ResolvedHistory, 'debug'> {
  if (value !== undefined && !isObjectLike(value)) {
    throw new UsageError(
      `${where} in ${file} must be an object like { store: local(), artifacts: 'failures' } (got ${JSON.stringify(value)})`,
    )
  }
  const history = (value ?? {}) as HistoryConfig & Record<string, unknown>
  unknownKey(history, HISTORY_KEYS, where, file)
  const artifacts: ArtifactLevel = history.artifacts ?? base?.artifacts ?? 'failures'
  if (!ARTIFACTS.includes(artifacts)) {
    throw new UsageError(
      `${where}.artifacts in ${file} is ${oneOf(ARTIFACTS)} (got ${JSON.stringify(artifacts)})`,
    )
  }
  const { store } = history
  const at = `${where}.store`
  if (store === undefined) {
    return base
      ? { ...base, artifacts }
      : localHistory({ kind: 'local' }, root, defaultDir, artifacts)
  }
  if (!isObjectLike(store) || !isString((store as { kind?: unknown }).kind)) {
    throw new UsageError(
      `${at} in ${file} must be ${STORE_EXAMPLE}: reeval keeps runs in a local folder or an S3-compatible bucket (got ${describe(store)})`,
    )
  }
  const kind = (store as { kind: string }).kind
  if (kind === 'local') {
    unknownKey(store, LOCAL_KEYS, at, file)
    checkString((store as LocalStoreDescriptor).dir, `${at}.dir`, file)
    return localHistory(store as LocalStoreDescriptor, root, defaultDir, artifacts)
  }
  if (kind === 's3') {
    const s3 = checkS3(store as Record<string, unknown>, at, file)
    const id = storeId(s3Location(s3))
    return {
      dir: join(storeStateDir(root, id), 'history'),
      artifacts,
      scope: 'reachable',
      store: { kind: 's3', descriptor: s3, name: s3Name(s3) },
    }
  }
  const near = closest(kind, ['local', 's3'])
  throw new UsageError(
    `${at} in ${file} is a store of kind ${JSON.stringify(kind)}, which reeval doesn't have: use ${STORE_EXAMPLE}.${near ? ` Did you mean '${near}'?` : ''}`,
  )
}

function localHistory(
  store: LocalStoreDescriptor,
  root: string,
  defaultDir: string,
  artifacts: ArtifactLevel,
): Omit<ResolvedHistory, 'debug'> {
  return {
    dir: resolve(root, store.dir ?? defaultDir),
    artifacts,
    store: { kind: 'local', name: 'local' },
  }
}

/**
 * Refuses a history kept anywhere but a local folder: the studio reads only `local()`, so it
 * would show a remote store's copy as if it were the whole store.
 */
export function localStudio(config: { history: ResolvedHistory; file: string }): void {
  const { store } = config.history
  if (store.kind === 'local') return
  throw new UsageError(
    `reeval studio reads a local() history only, and history.store in ${config.file} keeps runs in ${store.name}. Run it with a profile whose history is local(), or none.`,
  )
}
