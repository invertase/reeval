import { format } from '#strfmt'

export function receiptLine(item, quantity, price) {
  return format('%s × %s: %s', item, quantity, price.toFixed(2))
}

export function total(sum) {
  return format('Total: %s', sum.toFixed(2))
}
