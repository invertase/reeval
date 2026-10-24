// The fake release server launchers download from in the conformance suite: one HTTP and one HTTPS
// listener on 127.0.0.1, serving one release under /r/ (`{base}/SHA256SUMS` and `{base}/{asset}`)
// in whichever mode the current step asks for.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  createCertificateAuthority,
  issueServerCertificate,
} from '../../../../sandbox-docker/src/egress/cert.ts'

/**
 * How the release answers:
 * - `good`: SHA256SUMS lists the asset as `<sha256> *<asset>` and the asset is served
 * - `good-text`: the same, with SHA256SUMS in text mode (`<sha256>  <asset>`)
 * - `slow`: as `good`, but each asset response pauses half way, so concurrent downloads overlap
 * - `bad-checksum`: SHA256SUMS lists another hash for the asset
 * - `unlisted`: SHA256SUMS lists only another target's asset
 * - `truncated`: the asset's response promises every byte, sends half and drops the connection
 * - `missing`: every path is a 404
 * - `https-redirect`: over HTTPS, every path redirects to the same release elsewhere on HTTPS
 * - `https-to-http`: over HTTPS, every path redirects to the same release on the HTTP listener
 */
export type Mode =
  | 'good'
  | 'good-text'
  | 'slow'
  | 'bad-checksum'
  | 'unlisted'
  | 'truncated'
  | 'missing'
  | 'https-redirect'
  | 'https-to-http'

export type Release = { mode: Mode; asset: string; binary: Buffer }

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export const WRONG_SHA256 = sha256('not reeval')

export type ReleaseServer = {
  http: string
  https: string
  /** The CA that signed the HTTPS listener's certificate, as a PEM file. */
  caFile: string
  set(release: Release): void
  /** The requests since the last `set`, as `<scheme> <path>`. */
  requests: string[]
  close(): Promise<void>
}

export async function startReleaseServer(dir: string): Promise<ReleaseServer> {
  let release: Release = { mode: 'missing', asset: '', binary: Buffer.alloc(0) }
  const requests: string[] = []
  const ca = createCertificateAuthority()
  const cert = issueServerCertificate(ca, '127.0.0.1')
  const caFile = join(dir, 'ca.pem')
  writeFileSync(caFile, ca.cert)

  const sums = () => {
    const other = `${WRONG_SHA256} *${release.asset.replace(/-(linux|darwin|windows)-/, '-other-')}`
    const listed = release.mode === 'bad-checksum' ? WRONG_SHA256 : sha256(release.binary)
    const line =
      release.mode === 'good-text' ? `${listed}  ${release.asset}` : `${listed} *${release.asset}`
    return `${release.mode === 'unlisted' ? '' : `${line}\n`}${other}\n`
  }

  const serve =
    (scheme: 'http' | 'https') => (req: http.IncomingMessage, res: http.ServerResponse) => {
      const path = req.url ?? '/'
      requests.push(`${scheme} ${path}`)
      const { mode, asset, binary } = release
      if (scheme === 'https' && mode === 'https-to-http' && path.startsWith('/r/')) {
        res.writeHead(302, { location: `${urls.http}${path.slice(2)}` }).end()
        return
      }
      if (scheme === 'https' && mode === 'https-redirect' && path.startsWith('/r/')) {
        res.writeHead(302, { location: `${urls.https.replace(/\/r$/, '/s')}${path.slice(2)}` })
        res.end()
        return
      }
      const file = path.replace(/^\/[rs]\//, '')
      if (mode === 'missing' || file === path) {
        res.writeHead(404).end('not found\n')
      } else if (file === 'SHA256SUMS') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(sums())
      } else if (file === asset) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': binary.length,
        })
        const half = binary.subarray(0, binary.length >> 1)
        if (mode === 'truncated') {
          res.write(half, () => res.socket?.destroy())
        } else if (mode === 'slow') {
          res.write(half)
          setTimeout(() => res.end(binary.subarray(half.length)), 400)
        } else {
          res.end(binary)
        }
      } else {
        res.writeHead(404).end('not found\n')
      }
    }

  const plain = http.createServer(serve('http'))
  const secure = https.createServer(
    { cert: cert.cert, key: cert.key.export({ type: 'pkcs8', format: 'pem' }) },
    serve('https'),
  )
  const listen = (server: http.Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    )
  const urls = {
    http: `http://127.0.0.1:${await listen(plain)}/r`,
    https: `https://127.0.0.1:${await listen(secure)}/r`,
  }
  return {
    ...urls,
    caFile,
    set(next) {
      release = next
      requests.length = 0
    },
    requests,
    async close() {
      for (const server of [plain, secure]) {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
    },
  }
}

/** A port nothing listens on, for a mirror that's unreachable. */
export async function deadPort(): Promise<number> {
  const server = http.createServer()
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  )
  await new Promise((resolve) => server.close(resolve))
  return port
}
