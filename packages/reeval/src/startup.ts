// What reeval takes from its process before any project or eval code runs in it, so reeval's own
// calls with a held key aren't steered by code that runs later: the environment as the CLI and
// the project's `.env` files set it, and the runtime's own `fetch`.

/** The runtime's `fetch`, as it was when reeval started. */
export const nativeFetch: typeof fetch = globalThis.fetch

let pinned: NodeJS.ProcessEnv | undefined

/**
 * Keeps a copy of the environment as it is now: at start, and again once the CLI has loaded the
 * project's `.env` files, before it loads any eval file. Null lets the copy go.
 */
export function pinStartEnv(env: NodeJS.ProcessEnv | null = process.env): void {
  pinned = env ? { ...env } : undefined
}

/** The environment as last pinned; the live one in a process that never pinned it. */
export const startEnv = (): NodeJS.ProcessEnv => pinned ?? process.env
