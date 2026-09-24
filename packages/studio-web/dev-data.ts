import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'

const DATA = /^\/(?:data\/|studio\.json|api\/)/

/**
 * Dev only: serves the studio data routes from `ES_STUDIO_PROJECT` (an ES project folder) on the
 * Vite origin, through the same Hono app as `es studio`. Needs `pnpm --filter evalsuite build`.
 */
export function studioDevData(): Plugin {
  return {
    name: 'es-studio-dev-data',
    apply: 'serve',
    async configureServer(server) {
      const project = process.env.ES_STUDIO_PROJECT
      if (!project) {
        server.config.logger.warn('Set ES_STUDIO_PROJECT=<es project dir> to load run history.')
        return
      }
      const root = resolve(project)
      const dist = new URL('../evalsuite/dist/', import.meta.url)
      const { loadConfig } = await import(new URL('config.js', dist).href)
      const { devListener } = await import(new URL('studio/index.js', dist).href)
      const config = await loadConfig(join(root, 'es.config.ts'), 'studio')
      const listener = devListener(
        { root: config.root, historyDir: config.history.dir, scratch: true },
        'dev',
      )
      server.middlewares.use((req, res, next) => {
        if (req.url && DATA.test(req.url)) listener(req, res)
        else next()
      })
    },
  }
}
