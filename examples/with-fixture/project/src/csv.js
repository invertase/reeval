/** Parses CSV text with a header row into one object per line. */
export function parseCsv(text) {
  const [header, ...rows] = text.trim().split('\n')
  const keys = header.split(',')
  return rows.map((row) => Object.fromEntries(row.split(',').map((v, i) => [keys[i], v])))
}
