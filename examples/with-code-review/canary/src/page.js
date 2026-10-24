// Returns page `number` of `items`, `size` items a page. Pages count from 1.
export function page(items, number, size = 10) {
  const start = (number - 1) * size
  return items.slice(start, start + size)
}

export function pageCount(items, size = 10) {
  return Math.ceil(items.length / size)
}
