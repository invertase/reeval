export function add(a, b) {
  return a + b
}

export function divide(a, b) {
  if (b === 0) throw new RangeError(`divide(${a}, 0): the divisor b must not be 0`)
  return a / b
}
