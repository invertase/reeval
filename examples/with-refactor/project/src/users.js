// A user record is one line: `id=1;name=Ada;email=ada@example.com`.
export function parseUser(line) {
  const fields = {}
  for (const pair of line.trim().split(';')) {
    if (!pair) continue
    const [key, ...rest] = pair.split('=')
    fields[key.trim()] = rest.join('=').trim()
  }
  return { id: Number(fields.id), name: fields.name, email: fields.email }
}
