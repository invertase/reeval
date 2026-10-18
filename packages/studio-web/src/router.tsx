import type { QueryClient } from '@tanstack/react-query'
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { Shell } from '@/components/shell'
import { headersQuery, recordQuery } from '@/lib/data'
import { AttemptPage, TABS, type Tab } from '@/pages/attempt'
import { ComparePage } from '@/pages/compare'
import { EvalHistoryPage } from '@/pages/eval-history'
import { EvalsPage } from '@/pages/evals'
import { LiveAttemptPage, LiveRunPage } from '@/pages/live-run'
import { NotFoundPage } from '@/pages/not-found'
import { RunPage } from '@/pages/run'
import { RunsPage } from '@/pages/runs'

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const oneOf = <T extends string>(values: readonly T[], v: unknown): T | undefined =>
  values.find((value) => value === v)

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Shell,
  notFoundComponent: NotFoundPage,
})

export type RunsSearch = {
  q?: string
  status?: 'passed' | 'failed'
  source?: 'recorded' | 'scratch'
}

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (s: Record<string, unknown>): RunsSearch => ({
    q: str(s.q),
    status: oneOf(['passed', 'failed'] as const, s.status),
    source: oneOf(['recorded', 'scratch'] as const, s.source),
  }),
  loader: ({ context }) => context.queryClient.prefetchQuery(headersQuery),
  component: RunsPage,
})

export type RunSearch = { eval?: string; show?: 'failed'; tab?: 'analysis' }

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId',
  validateSearch: (s: Record<string, unknown>): RunSearch => ({
    eval: str(s.eval),
    show: oneOf(['failed'] as const, s.show),
    tab: oneOf(['analysis'] as const, s.tab),
  }),
  loader: ({ context, params }) => context.queryClient.prefetchQuery(recordQuery(params.runId)),
  component: RunPage,
})

const attemptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs/$runId/evals/$slug/attempts/$attempt',
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({ tab: oneOf(TABS, s.tab) }),
  loader: ({ context, params }) => context.queryClient.prefetchQuery(recordQuery(params.runId)),
  component: AttemptPage,
})

const liveRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/live/$runId',
  component: LiveRunPage,
})

const liveAttemptRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/live/$runId/attempt',
  validateSearch: (s: Record<string, unknown>): { key?: string } => ({ key: str(s.key) }),
  component: LiveAttemptPage,
})

const evalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evals',
  validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: str(s.q) }),
  component: EvalsPage,
})

const evalHistoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/evals/$slug',
  component: EvalHistoryPage,
})

export type CompareSearch = { base?: string; head?: string }

const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/compare',
  validateSearch: (s: Record<string, unknown>): CompareSearch => ({
    base: str(s.base),
    head: str(s.head),
  }),
  component: ComparePage,
})

const routeTree = rootRoute.addChildren([
  runsRoute,
  runRoute,
  attemptRoute,
  liveRunRoute,
  liveAttemptRoute,
  evalsRoute,
  evalHistoryRoute,
  compareRoute,
])

export function makeRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    history: createHashHistory(),
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
