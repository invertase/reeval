// 25 notes, sorted by id: n01 to n25.
export const notes = Array.from({ length: 25 }, (_, i) => ({
  id: `n${String(i + 1).padStart(2, '0')}`,
  text: `Note ${i + 1}`,
}))

// `cursor` is the id of the last note the previous page returned.
export function listNotes({ cursor } = {}) {
  const start = cursor ? notes.findIndex((note) => note.id === cursor) + 1 : 0
  const page = notes.slice(start, start + 10)
  const nextCursor = start + 10 < notes.length ? page.at(-1).id : null
  return { notes: page, nextCursor }
}
