export function add(a, b) {
  return a + b
}

export function average(xs) {
  if (xs.length === 0) return 0
  return xs.reduce(add, 0) / xs.length
}
