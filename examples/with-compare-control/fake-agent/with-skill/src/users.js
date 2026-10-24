const users = [
  { id: 'u1', name: 'Ada' },
  { id: 'u2', name: 'Grace' },
  { id: 'u3', name: 'Linus' },
  { id: 'u4', name: 'Margaret' },
  { id: 'u5', name: 'Dennis' },
]

export function listUsers({ cursor, limit = 10 } = {}) {
  const start = cursor ? users.findIndex((u) => u.id === cursor) + 1 : 0
  const data = users.slice(start, start + limit)
  const last = start + limit >= users.length
  return { data, nextCursor: last ? null : (data.at(-1)?.id ?? null) }
}
