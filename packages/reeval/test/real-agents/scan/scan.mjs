// Searches the sandbox for a value without being given it: each target is the sha256, length and
// a 32-bit rolling hash of one form of the value (raw, base64, …). Every process's environment and
// command line, and every file up to 8 MB under the writable roots, are scanned with a rolling hash
// over each window of the target's length; a window whose hash matches is confirmed by sha256.
// Prints { files, bytes, hits }, where each hit names where a target was found. The same scanner
// as the harness contract's (packages/reeval/test/contract/scan.mjs).
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const B = 257
const targets = JSON.parse(process.argv[2] ?? '[]')
const ROOTS = ['/root', '/reeval', '/tmp', '/etc', '/home', '/var/tmp', '/run', '/opt', '/srv']
const MAX = 8 * 1024 * 1024
const hits = []
let files = 0
let bytes = 0

/** B^(len-1) mod 2^32, to drop the byte leaving the window. */
const powers = new Map(
  targets.map((t) => {
    let p = 1
    for (let i = 1; i < t.len; i++) p = Math.imul(p, B) >>> 0
    return [t.len, p]
  }),
)

function search(buf, where) {
  files++
  bytes += buf.length
  for (const t of targets) {
    if (buf.length < t.len) continue
    const pow = powers.get(t.len)
    let h = 0
    for (let i = 0; i < t.len; i++) h = (Math.imul(h, B) + buf[i]) >>> 0
    for (let i = 0; ; i++) {
      if (h === t.roll) {
        const sha = createHash('sha256')
          .update(buf.subarray(i, i + t.len))
          .digest('hex')
        if (sha === t.sha256) {
          hits.push(`${where} (${t.form})`)
          break
        }
      }
      if (i + t.len >= buf.length) break
      h = (h - Math.imul(buf[i], pow)) >>> 0
      h = (Math.imul(h, B) + buf[i + t.len]) >>> 0
    }
  }
}

function read(path) {
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
  for (const part of ['environ', 'cmdline']) {
    const buf = read(`/proc/${pid}/${part}`)
    if (buf) search(buf, `/proc/${pid}/${part}`)
  }
}

function walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(dir, name)
    let st
    try {
      st = lstatSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(path)
    else if (st.isFile() && st.size <= MAX) {
      const buf = read(path)
      if (buf) search(buf, path)
    }
  }
}
for (const root of ROOTS) walk(root)

process.stdout.write(JSON.stringify({ files, bytes, hits }))
