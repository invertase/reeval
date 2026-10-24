import { format } from '#strfmt'

export function receiptLine(item, quantity, price) {
  return format('{item} × {quantity}: {price}', { item, quantity, price: price.toFixed(2) })
}

export function total(sum) {
  return format('Total: {sum}', { sum: sum.toFixed(2) })
}
