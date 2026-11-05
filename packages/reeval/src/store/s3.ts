// `s3()` as a `HistoryStore`, on an S3-compatible API (AWS S3, Cloudflare R2, MinIO):
//
//   <prefix>/reeval-store.json                       { kind: 'reeval-store', schemaVersion: 1 }
//   <prefix>/runs/<YYYY-MM>/<runId>.json             the record, written last
//   <prefix>/runs/<YYYY-MM>/<runId>/<path>           every file beside it
//
// Every key is under its run id, so concurrent writers never touch one object. The record is
// created with `If-None-Match: *` and replaced with `If-Match: <etag>`, so a run lands whole once.
import { S3Client, S3Errors } from '@bradenmacdonald/s3-lite-client'
import { UsageError } from '../errors.ts'
import { RUN_ID } from '../ids.ts'
import type { HistoryStore, S3StoreDescriptor, StoredRun, StoredRunVersion } from '../types.ts'
import { checkEndpoint, S3_ENV_DEFAULTS, s3Name } from './resolve.ts'

const MARKER = 'reeval-store.json'
const MARKER_BYTES = `${JSON.stringify({ kind: 'reeval-store', schemaVersion: 1 })}\n`

type Env = Record<string, string | undefined>

/** The client settings `descriptor` and the host's variables give; refuses a missing one. */
export function s3Settings(descriptor: S3StoreDescriptor, env: Env = process.env) {
  const from = (field: keyof NonNullable<S3StoreDescriptor['env']>, fallback?: string) => {
    const name = descriptor.env?.[field] ?? fallback
    const value = name ? env[name] : undefined
    return { name, value: value === '' ? undefined : value }
  }
  const required = (what: string, got: { name?: string; value?: string }) => {
    if (got.value) return got.value
    throw new UsageError(
      `${s3Name(descriptor)} needs ${what}: set ${got.name} in the environment (.env.local works too).`,
    )
  }
  const bucket = descriptor.bucket ?? required('its bucket', from('bucket'))
  let endpoint = descriptor.endpoint
  if (!endpoint) {
    const got = from('endpoint', 'AWS_ENDPOINT_URL_S3')
    endpoint = descriptor.env?.endpoint ? required('its endpoint', got) : got.value
    if (endpoint) endpoint = checkEndpoint(endpoint, `${got.name}`, 'the environment')
  }
  const r2 = endpoint ? new URL(endpoint).hostname.endsWith('.r2.cloudflarestorage.com') : false
  const region =
    descriptor.region ??
    from('region').value ??
    env.AWS_REGION ??
    env.AWS_DEFAULT_REGION ??
    (r2 ? 'auto' : 'us-east-1')
  const accessKey = required('an access key', from('accessKeyId', S3_ENV_DEFAULTS.accessKeyId))
  const secretKey = required(
    'a secret key',
    from('secretAccessKey', S3_ENV_DEFAULTS.secretAccessKey),
  )
  const sessionToken = from('sessionToken', S3_ENV_DEFAULTS.sessionToken).value
  return {
    endPoint: endpoint ?? `https://s3.${region}.amazonaws.com`,
    region,
    bucket,
    accessKey,
    secretKey,
    ...(sessionToken ? { sessionToken } : {}),
  }
}

const statusOf = (error: unknown) =>
  error instanceof S3Errors.ServerError ? error.statusCode : undefined

const unquote = (etag: string) => etag.replace(/^W\//, '').replace(/^"|"$/g, '')

const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  md: 'text/markdown; charset=utf-8',
  ndjson: 'application/x-ndjson',
  jsonl: 'application/x-ndjson',
  log: 'text/plain; charset=utf-8',
  patch: 'text/x-diff; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
}
const contentType = (path: string) =>
  CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream'

/** `2026-09`, the month shard a run's keys are under. */
const month = (runId: string) => `${runId.slice(0, 4)}-${runId.slice(4, 6)}`

/** A `HistoryStore` on the bucket `descriptor` names, its keys read from `env` when it's used. */
export function s3Store(descriptor: S3StoreDescriptor, env: Env = process.env): HistoryStore {
  const base = descriptor.prefix ? `${descriptor.prefix}/` : ''
  let client: S3Client | undefined
  let marked: Promise<void> | undefined
  const s3 = () => {
    client ??= new S3Client(s3Settings(descriptor, env))
    return client
  }
  const runKey = (runId: string) => {
    if (!RUN_ID.test(runId)) throw new UsageError(`${runId} isn't a run id`)
    return `${base}runs/${month(runId)}/${runId}`
  }
  const put = async (key: string, bytes: Uint8Array | string, condition?: [string, string]) => {
    const headers = new Headers({ 'Content-Type': contentType(key) })
    if (condition) headers.set(condition[0], condition[1])
    const response = await s3().makeRequest({
      method: 'PUT',
      objectName: key,
      headers,
      payload: typeof bytes === 'string' ? bytes : new Uint8Array(bytes),
    })
    return unquote(response.headers.get('etag') ?? '')
  }
  const get = async (key: string) => {
    try {
      const response = await s3().getObject(key)
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        version: unquote(response.headers.get('etag') ?? ''),
      }
    } catch (error) {
      if (statusOf(error) === 404) return null
      throw error
    }
  }
  const list = async (prefix: string) => {
    const keys: string[] = []
    for await (const object of s3().listObjects({ prefix })) keys.push(object.key)
    return keys
  }
  /** Creates the bucket's marker once, and refuses a prefix something else wrote. */
  const mark = () => {
    marked ??= (async () => {
      const found = await get(`${base}${MARKER}`)
      if (found) {
        const value = JSON.parse(Buffer.from(found.bytes).toString()) as { kind?: unknown }
        if (value?.kind !== 'reeval-store') {
          throw new UsageError(
            `${s3Name(descriptor)}/${MARKER} isn't reeval's: give history.store a prefix of its own.`,
          )
        }
        return
      }
      try {
        await put(`${base}${MARKER}`, MARKER_BYTES, ['If-None-Match', '*'])
      } catch (error) {
        if (statusOf(error) !== 412) throw error
      }
    })()
    marked.catch(() => {
      marked = undefined
    })
    return marked
  }
  return {
    name: s3Name(descriptor),
    async listRuns(): Promise<StoredRunVersion[]> {
      const record = new RegExp(
        `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}runs/\\d{4}-\\d{2}/([^/]+)\\.json$`,
      )
      const runs: StoredRunVersion[] = []
      for await (const object of s3().listObjects({ prefix: `${base}runs/` })) {
        const runId = record.exec(object.key)?.[1]
        if (runId && RUN_ID.test(runId)) runs.push({ runId, version: unquote(object.etag) })
      }
      return runs
    },
    async readRun(runId) {
      const key = runKey(runId)
      const record = await get(`${key}.json`)
      if (!record) return null
      const files = new Map<string, Uint8Array>()
      for (const file of await list(`${key}/`)) {
        const found = await get(file)
        if (found) files.set(file.slice(key.length + 1), found.bytes)
      }
      return { runId, record: record.bytes, files, version: record.version }
    },
    async writeRun(run: StoredRun, options: { replaces?: string }) {
      await mark()
      const key = runKey(run.runId)
      for (const [path, bytes] of run.files) await put(`${key}/${path}`, bytes)
      let version: string
      try {
        version = await put(
          `${key}.json`,
          run.record,
          options.replaces ? ['If-Match', `"${options.replaces}"`] : ['If-None-Match', '*'],
        )
      } catch (error) {
        // 409: a conditional write raced another one to the same key (S3 and R2).
        if (statusOf(error) === 412 || statusOf(error) === 409) return { ok: false }
        throw error
      }
      if (options.replaces) {
        for (const file of await list(`${key}/`)) {
          if (!run.files.has(file.slice(key.length + 1))) await s3().deleteObject(file)
        }
      }
      return { ok: true, version }
    },
    async addFile(runId, path, bytes) {
      await put(`${runKey(runId)}/${path}`, bytes)
    },
  }
}
