/** Parses CSV text with a header row into one object per line. */
export function parseCsv(text) {
  const [header, ...rows] = text.trim().split('\n')
  const keys = header.split(',')
  return rows.map((row) => Object.fromEntries(row.split(',').map((v, i) => [keys[i], v])))
}

/** Turns objects back into CSV text, with a header row from the first one's keys. */
export function stringifyCsv(rows) {
  const keys = Object.keys(rows[0] ?? {})
  const lines = [keys.join(','), ...rows.map((row) => keys.map((k) => row[k]).join(','))]
  return `${lines.join('\n')}\n`
}
