import { page } from './page.js'

// Titles that contain `query`, ignoring case, one page at a time.
export function search(titles, query, number = 1) {
  const needle = query.toLowerCase()
  const matches = titles.filter((title) => title.toLowerCase().includes(needle))
  return page(matches, number)
}
