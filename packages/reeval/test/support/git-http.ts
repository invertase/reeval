// A git smart-HTTP server for tests: `git http-backend` behind a listener on 127.0.0.1 that
// answers 401 unless the request carries `token` the way reeval's `git(…, { token })` sends it.
// `serve(dir)` gives the URL under which the repositories in `dir` are served by name.
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type GitHttp = {
  serve(dir: string): string
  requests: string[]
  close(): Promise<void>
}

export async function gitHttpServer(token: string): Promise<GitHttp> {
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  const requests: string[] = []
  const roots: string[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(`${req.method} ${url.pathname}`)
    const [, id = '', ...rest] = url.pathname.split('/')
    const root = roots[Number(id)]
    if (!root) {
      res.writeHead(404)
      res.end()
      return
    }
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="reeval-test"' })
      res.end()
      return
    }
    const backend = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${decodeURIComponent(rest.join('/'))}`,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        REMOTE_ADDR: '127.0.0.1',
      },
    })
    req.pipe(backend.stdin)
    const chunks: Buffer[] = []
    backend.stdout.on('data', (c: Buffer) => chunks.push(c))
    backend.on('close', () => {
      const out = Buffer.concat(chunks)
      const split = out.indexOf('\r\n\r\n')
      const head = out.subarray(0, split).toString('utf8').split('\r\n')
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of head) {
        const [name = '', ...rest] = line.split(':')
        const value = rest.join(':').trim()
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
        else if (name) headers[name] = value
      }
      res.writeHead(status, headers)
      res.end(out.subarray(split + 4))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    serve: (dir) => `http://127.0.0.1:${port}/${roots.push(dir) - 1}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
