import { readFileSync } from 'node:fs'
import { parseCsv } from './csv.js'

const orders = parseCsv(readFileSync('data/orders.csv', 'utf8'))
const total = orders.reduce((sum, order) => sum + Number(order.total), 0)
console.log(`${orders.length} orders, total ${total.toFixed(2)}`)
