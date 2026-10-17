// `reeval mcp`: serves the run history over MCP, on stdio (the host launches it) or, with `--http`,
// as stateless Streamable HTTP on a local port.
import { timingSafeEqual } from 'node:crypto'
import { basename } from 'node:path'
import { UsageError } from '../errors.ts'
import { fromCwd } from '../ids.ts'
import { redactSecrets, registerSecret } from '../redact.ts'
import type { ResolvedConfig } from '../types.ts'
import { serverFactory } from './server.ts'

export type McpFlags = { http?: boolean; port?: string; host?: string; token?: string }

type Args = { config: ResolvedConfig; flags: McpFlags; version: string }

export const DEFAULT_MCP_PORT = 4986

const report = (error: Error) => console.error(`reeval mcp: ${redactSecrets(error.message)}`)

const stopped = () =>
  new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })

export async function mcpCommand({ config, flags, version }: Args): Promise<number> {
  if (!flags.http) {
    for (const name of ['port', 'host', 'token'] as const) {
      if (flags[name] !== undefined)
        throw new UsageError(`--${name} needs --http: reeval mcp serves over stdio without it`)
    }
  }
  const factory = await serverFactory(config, version)
  if (!flags.http) {
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio')
    const handle = serveStdio(factory, { onerror: report })
    // The host closing stdin ends the connection; so does a signal.
    await Promise.race([
      new Promise<void>((resolve) => {
        process.stdin.once('end', resolve)
        process.stdin.once('close', resolve)
      }),
      stopped(),
    ])
    await handle.close()
    return 0
  }
  return serveHttp(factory, config, flags)
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function serveHttp(
  factory: Awaited<ReturnType<typeof serverFactory>>,
  config: ResolvedConfig,
  flags: McpFlags,
): Promise<number> {
  const port = flags.port === undefined ? DEFAULT_MCP_PORT : Number(flags.port)
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new UsageError(`--port must be a port number (got ${flags.port})`)
  }
  const host = flags.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.error(`warning: reeval mcp is listening on ${host}, reachable beyond this machine`)
  }
  // Off by default: bound to loopback behind the Host and Origin checks, like any local dev server.
  const token = flags.token ?? (process.env.REEVAL_MCP_TOKEN || undefined)
  if (token !== undefined && !token.trim())
    throw new UsageError('--token needs a value: --token <secret>, or REEVAL_MCP_TOKEN')
  registerSecret(token)
  const { createMcpHandler } = await import('@modelcontextprotocol/server')
  const { Hono } = await import('hono')
  const { serve } = await import('@hono/node-server')
  const { allowedHosts } = await import('../studio/server.ts')
  const hosts = allowedHosts(host, port)
  const handler = createMcpHandler(factory, { onerror: report })
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (!hosts.includes(c.req.header('host') ?? '')) return c.text('Unknown host', 403)
    const origin = c.req.header('origin')
    if (origin && !hosts.some((h) => origin === `http://${h}`)) {
      return c.text('Cross-origin requests are not allowed', 403)
    }
    if (token) {
      const offered = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1]
      if (!offered || !sameToken(offered, token)) {
        return c.text('reeval mcp needs its bearer token (--token or REEVAL_MCP_TOKEN)', 401, {
          'WWW-Authenticate': 'Bearer',
        })
      }
    }
    return next()
  })
  app.post('/mcp', (c) => handler.fetch(c.req.raw))
  app.all('/mcp', (c) => c.text('Method not allowed', 405, { Allow: 'POST' }))
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: host, port })
    s.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new UsageError(`Port ${port} is in use: pass another with --port`)
          : error,
      ),
    )
    s.once('listening', () => resolve(s))
  })
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp`
  console.log(`reeval mcp · ${basename(config.root)} · ${fromCwd(config.history.dir) || '.'}/`)
  console.log(`  ${url}`)
  if (token) console.log('  requires Authorization: Bearer <the --token or REEVAL_MCP_TOKEN value>')
  console.log('Ctrl-C to stop.')
  await stopped()
  await handler.close()
  server.close()
  return 0
}
