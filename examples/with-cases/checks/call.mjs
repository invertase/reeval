// Prints fn(...args) from the workspace's src/math.js: node ~/checks/call.mjs multiply 2 3
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [fn, ...args] = process.argv.slice(2)
const math = await import(pathToFileURL(resolve('src/math.js')).href)
console.log(math[fn](...args.map(Number)))
