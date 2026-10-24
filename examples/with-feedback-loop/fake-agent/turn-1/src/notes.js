// 25 notes, sorted by id: n01 to n25.
export const notes = Array.from({ length: 25 }, (_, i) => ({
  id: `n${String(i + 1).padStart(2, '0')}`,
  text: `Note ${i + 1}`,
}))

export function listNotes({ page = 1 } = {}) {
  const start = (page - 1) * 10
  return { notes: notes.slice(start, start + 10), page }
}
