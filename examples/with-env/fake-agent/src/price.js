export function price(cents) {
  const currency = process.env.CURRENCY || 'USD'
  return `${currency} ${(cents / 100).toFixed(2)}`
}
