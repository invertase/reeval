import type { CaptureFailedRequest, CapturePage } from '../types.ts'

/** `GET /missing.js → 404`, or `→ net::ERR_…` when no response came. */
export const failedRequestLine = (r: CaptureFailedRequest) =>
  `${r.method} ${r.url} → ${r.status ?? r.error ?? 'failed'}`

/** A capture's page facts as a line each: its page errors, console messages, then failed requests. */
export function pageLines(page: CapturePage): string[] {
  return [
    ...page.errors.map((e) => `page error: ${e}`),
    ...page.console.map((l) => `console ${l.level} (${l.source}): ${l.text}`),
    ...page.failedRequests.map((r) => `failed request: ${failedRequestLine(r)}`),
  ]
}
