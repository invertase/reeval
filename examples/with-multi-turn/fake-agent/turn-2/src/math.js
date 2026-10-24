export function add(a, b) {
  return a + b
}

export function multiply(...numbers) {
  return numbers.reduce((product, n) => product * n, 1)
}
