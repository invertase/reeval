const notes = new Map([
  ['1', { id: '1', text: 'Buy milk' }],
  ['2', { id: '2', text: 'Call Ada' }],
])

const notFound = (id) => ({
  status: 404,
  body: { error: { code: 'not_found', message: `No note ${id}.` } },
})

export function getNote(id) {
  const note = notes.get(id)
  if (!note) return notFound(id)
  return { status: 200, body: note }
}

export function deleteNote(id) {
  if (!notes.delete(id)) return notFound(id)
  return { status: 204, body: null }
}
