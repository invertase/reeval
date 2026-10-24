import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 3000)

createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(readFileSync(new URL('./index.html', import.meta.url)))
}).listen(port, '127.0.0.1')
