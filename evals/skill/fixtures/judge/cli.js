#!/usr/bin/env node
// wordcount: counts the words in each file it's given, or in stdin.
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: wordcount [file...]\nCounts the words in each file, or in stdin.')
  process.exit(0)
}
const count = (text) => text.split(/\s+/).filter(Boolean).length
if (args.length === 0) console.log(count(readFileSync(0, 'utf8')))
for (const file of args) console.log(`${count(readFileSync(file, 'utf8'))} ${file}`)
