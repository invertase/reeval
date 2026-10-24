const notes = new Map([
  ['1', { id: '1', text: 'Buy milk' }],
  ['2', { id: '2', text: 'Call Ada' }],
])

export function getNote(id) {
  const note = notes.get(id)
  if (!note) {
    return { status: 404, body: { error: { code: 'not_found', message: `No note ${id}.` } } }
  }
  return { status: 200, body: note }
}
