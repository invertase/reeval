// 25 notes, sorted by id: n01 to n25.
export const notes = Array.from({ length: 25 }, (_, i) => ({
  id: `n${String(i + 1).padStart(2, '0')}`,
  text: `Note ${i + 1}`,
}))
