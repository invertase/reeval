// An order record is one line: `id=7;user=1;total=12.50`.
export function parseOrder(line) {
  const fields = {}
  for (const pair of line.trim().split(';')) {
    if (!pair) continue
    const [key, ...rest] = pair.split('=')
    fields[key.trim()] = rest.join('=').trim()
  }
  return { id: Number(fields.id), user: Number(fields.user), total: Number(fields.total) }
}
