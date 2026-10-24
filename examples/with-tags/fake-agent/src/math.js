export function add(a, b) {
  return a + b
}

export function multiply(a, b) {
  return a * b
}

export function divide(a, b) {
  if (b === 0) throw new RangeError('division by zero')
  return a / b
}
