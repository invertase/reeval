// A record is one line of `key=value` pairs separated by `;`.
export function parseRecord(line) {
  const fields = {}
  for (const pair of line.trim().split(';')) {
    if (!pair) continue
    const [key, ...rest] = pair.split('=')
    fields[key.trim()] = rest.join('=').trim()
  }
  return fields
}
