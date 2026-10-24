import { readFileSync } from 'node:fs'

const rows = readFileSync('orders.csv', 'utf8').trim().split('\n').slice(1)
const total = rows.reduce((sum, row) => sum + Number(row.split(',')[1]), 0)

console.log(`${rows.length} orders, total ${total.toFixed(2)}`)
