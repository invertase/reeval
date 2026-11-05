// A path-style S3 API in the test process: objects in a map, ListObjectsV2, and conditional PUTs
// (`If-None-Match: *`, `If-Match`), as AWS S3, R2 and MinIO answer them. It checks the request is
// signed with `accessKey` and can fail the next requests, to test retries and the outbox.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeS3 = {
  url: string
  bucket: string
  accessKey: string
  secretKey: string
  objects: Map<string, { bytes: Buffer; etag: string }>
  requests: Array<{ method: string; key: string; headers: IncomingMessage['headers'] }>
  /** The next `n` requests answer `status` (503 by default) and change nothing. */
  failNext(n: number, status?: number): void
  close(): Promise<void>
}

const xml = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'content-type': 'application/xml' })
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`)
}

const fail = (res: ServerResponse, status: number, code: string, message: string) =>
  xml(res, status, `<Error><Code>${code}</Code><Message>${message}</Message></Error>`)

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function fakeS3(
  options: { bucket?: string; accessKey?: string; secretKey?: string } = {},
): Promise<FakeS3> {
  const bucket = options.bucket ?? 'reeval-runs'
  const accessKey = options.accessKey ?? 'AKIAFAKES3TESTKEY01'
  const secretKey = options.secretKey ?? 'fake-s3-secret-key-for-tests-only'
  const objects = new Map<string, { bytes: Buffer; etag: string }>()
  const requests: FakeS3['requests'] = []
  let failing = 0
  let failStatus = 503
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url ?? '/', 'http://fake')
    const [, name, ...rest] = url.pathname.split('/')
    const key = decodeURIComponent(rest.join('/'))
    const method = req.method ?? 'GET'
    requests.push({ method, key, headers: req.headers })
    if (failing > 0) {
      failing--
      return fail(res, failStatus, 'ServiceUnavailable', 'injected failure')
    }
    if (!String(req.headers.authorization ?? '').includes(`Credential=${accessKey}/`)) {
      return fail(res, 403, 'InvalidAccessKeyId', 'The access key does not exist')
    }
    if (name !== bucket) return fail(res, 404, 'NoSuchBucket', `No bucket ${name}`)
    const found = objects.get(key)
    if (method === 'GET' && key === '' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const max = Number(url.searchParams.get('max-keys') ?? 1000)
      const after = url.searchParams.get('continuation-token') ?? ''
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort()
      const page = keys.slice(0, max)
      const truncated = keys.length > page.length
      const contents = page
        .map((k) => {
          const o = objects.get(k) as { bytes: Buffer; etag: string }
          return `<Contents><Key>${escapeXml(k)}</Key><LastModified>2026-11-05T00:00:00.000Z</LastModified><ETag>"${o.etag}"</ETag><Size>${o.bytes.length}</Size></Contents>`
        })
        .join('')
      const next = truncated
        ? `<NextContinuationToken>${escapeXml(page.at(-1) as string)}</NextContinuationToken>`
        : ''
      return xml(
        res,
        200,
        `<ListBucketResult><Name>${bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
      )
    }
    if (method === 'PUT') {
      const ifNone = req.headers['if-none-match']
      const ifMatch = req.headers['if-match']
      if (ifNone === '*' && found) {
        return fail(res, 412, 'PreconditionFailed', 'At least one of the pre-conditions failed')
      }
      if (ifMatch !== undefined && (!found || ifMatch !== `"${found.etag}"`)) {
        return fail(res, 412, 'PreconditionFailed', 'At least one of the pre-conditions failed')
      }
      const etag = createHash('md5').update(body).digest('hex')
      objects.set(key, { bytes: body, etag })
      res.writeHead(200, { etag: `"${etag}"` })
      return res.end()
    }
    if (method === 'GET' || method === 'HEAD') {
      if (!found) return fail(res, 404, 'NoSuchKey', 'The specified key does not exist.')
      res.writeHead(200, { etag: `"${found.etag}"`, 'content-length': found.bytes.length })
      return res.end(method === 'GET' ? found.bytes : undefined)
    }
    if (method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204)
      return res.end()
    }
    fail(res, 405, 'MethodNotAllowed', method)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    accessKey,
    secretKey,
    objects,
    requests,
    failNext(n, status = 503) {
      failing = n
      failStatus = status
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
