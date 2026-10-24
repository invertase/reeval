import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'

const DATA = /^\/(?:data\/|studio\.json|api\/)/

/**
 * Dev only: serves the studio data routes from `REEVAL_STUDIO_PROJECT` (a reeval project folder) on the
 * Vite origin, through the same Hono app as `reeval studio`. Needs `pnpm build` from the repo root.
 */
export function studioDevData(): Plugin {
  return {
    name: 'reeval-studio-dev-data',
    apply: 'serve',
    async configureServer(server) {
      const project = process.env.REEVAL_STUDIO_PROJECT
      if (!project) {
        server.config.logger.warn(
          'Set REEVAL_STUDIO_PROJECT=<reeval project dir> to load run history.',
        )
        return
      }
      const root = resolve(project)
      const dist = new URL('../reeval/dist/', import.meta.url)
      const { loadConfig } = await import(new URL('config.js', dist).href)
      const { devListener } = await import(new URL('studio/index.js', dist).href)
      const config = await loadConfig(join(root, 'reeval.config.ts'), 'studio')
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
