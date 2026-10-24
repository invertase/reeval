export function add(a, b) {
  return a + b
}

export function multiply(a, b) {
  if (typeof a !== 'number') throw new TypeError('a must be a number')
  if (typeof b !== 'number') throw new TypeError('b must be a number')
  return a * b
}
