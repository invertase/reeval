import { parseRecord } from './parse.js'

// A user record is one line: `id=1;name=Ada;email=ada@example.com`.
export function parseUser(line) {
  const fields = parseRecord(line)
  return { id: Number(fields.id), name: fields.name, email: fields.email }
}
