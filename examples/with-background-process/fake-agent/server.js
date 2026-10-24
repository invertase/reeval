import { createServer } from 'node:http'

const server = createServer((req, res) => {
  if (req.url === '/') {
    res.end('hello\n')
    return
  }
  if (req.url === '/health') {
    res.end('ok\n')
    return
  }
  res.statusCode = 404
  res.end('not found\n')
})

server.listen(4100)
