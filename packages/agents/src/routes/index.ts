// Every route that serves harnesses on one key, by name.
import { OPENROUTER_ROUTE } from './openrouter.ts'
import type { Route } from './route.ts'
import { VERCEL_ROUTE } from './vercel.ts'
import { openCodeVertexId } from './vertex.ts'

/** The routes that serve harnesses on one key. Vertex AI takes a minted token, so it has a table of its own. */
export type RouteName = 'vercel' | 'openrouter'

/** Every route that serves harnesses on one key, by name. */
export const ROUTES: Readonly<Record<RouteName, Route>> = {
  vercel: VERCEL_ROUTE,
  openrouter: OPENROUTER_ROUTE,
}

/** OpenCode's id for `model` on `route`, as that route writes it. */
export function openCodeModelOn(model: string, route: string): string {
  if (route === 'vertex') return openCodeVertexId(model)
  return Object.hasOwn(ROUTES, route) ? `${route}/${model}` : model
}
