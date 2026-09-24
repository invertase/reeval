const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return 'just now'
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

export const formatDate = (iso: string) => dateTime.format(new Date(iso))

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** `20260924T220414Z_f7e1b53_elliot-hesp` → `220414Z_f7e1b53` style short label. */
export const shortRunId = (runId: string) => runId.split('_').slice(0, 2).join('_')
