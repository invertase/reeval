export function price(cents) {
  return `USD ${(cents / 100).toFixed(2)}`
}
