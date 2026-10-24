import { parseRecord } from './parse.js'

// An order record is one line: `id=7;user=1;total=12.50`.
export function parseOrder(line) {
  const fields = parseRecord(line)
  return { id: Number(fields.id), user: Number(fields.user), total: Number(fields.total) }
}
