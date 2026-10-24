const UNITS = { h: 3_600_000, m: 60_000, s: 1000 }

// Parses a duration such as `1h30m` or `45s` into milliseconds.
export function parseDuration(text) {
  if (!/^(\d+[hms])+$/.test(text)) throw new Error(`Not a duration: ${text}`)
  let ms = 0
  for (const [, count, unit] of text.matchAll(/(\d+)([hms])/g)) ms += Number(count) * UNITS[unit]
  return ms
}
