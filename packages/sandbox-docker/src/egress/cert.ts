import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'
import { isIP } from 'node:net'

// Just enough DER to issue X.509 v3 certificates: Node can parse and verify them but not create them.

const der = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content)
  const n = body.length
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : n < 0x10000
          ? Buffer.from([0x82, n >> 8, n & 0xff])
          : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff])
  return Buffer.concat([Buffer.from([tag]), length, body])
}

const seq = (...items: Buffer[]) => der(0x30, ...items)
const set = (...items: Buffer[]) => der(0x31, ...items)
const octets = (bytes: Buffer) => der(0x04, bytes)
const utf8 = (text: string) => der(0x0c, Buffer.from(text, 'utf8'))
const bool = (value: boolean) => der(0x01, Buffer.from([value ? 0xff : 0]))
const explicit = (n: number, inner: Buffer) => der(0xa0 + n, inner)

const integer = (bytes: Buffer) => {
  let i = 0
  while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1] as number) < 0x80) i++
  const trimmed = bytes.subarray(i)
  return der(
    0x02,
    (trimmed[0] as number) >= 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  )
}

const bits = (bytes: Buffer, unused = 0) => der(0x03, Buffer.from([unused]), bytes)

const oid = (dotted: string) => {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a + b]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return der(0x06, Buffer.from(out))
}

const time = (date: Date) => {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : der(0x18, Buffer.from(`${iso}Z`))
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))
const name = (commonName: string) =>
  seq(set(seq(oid('2.5.4.10'), utf8('evalsuite'))), set(seq(oid('2.5.4.3'), utf8(commonName))))
const extension = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value))

/** Key usage bits, most significant first, with DER's minimal "unused bits" count. */
const keyUsage = (usage: number) => {
  let unused = 0
  while (unused < 7 && !(usage & (1 << unused))) unused++
  return bits(Buffer.from([usage]), unused)
}

const keyId = (spki: Buffer) => createHash('sha1').update(spki).digest()

export type Certificate = { cert: string; key: KeyObject }
export type CertificateAuthority = Certificate & { spki: Buffer; subject: string }

const pem = (bytes: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${bytes
    .toString('base64')
    .replace(/.{64}/g, '$&\n')
    .replace(/\n?$/, '\n')}-----END CERTIFICATE-----\n`

function issue(options: {
  subject: string
  issuer: string
  publicKey: KeyObject
  signer: KeyObject
  authorityKeyId: Buffer
  extensions: Buffer[]
  days: number
}): string {
  const spki = options.publicKey.export({ type: 'spki', format: 'der' })
  const serial = randomBytes(16)
  serial[0] = (serial[0] as number) & 0x7f
  const notBefore = new Date(Date.now() - 3_600_000)
  const notAfter = new Date(notBefore.getTime() + options.days * 86_400_000)
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(options.issuer),
    seq(time(notBefore), time(notAfter)),
    name(options.subject),
    spki,
    explicit(
      3,
      seq(
        extension('2.5.29.14', false, octets(keyId(spki))),
        extension('2.5.29.35', false, seq(der(0x80, options.authorityKeyId))),
        ...options.extensions,
      ),
    ),
  )
  return pem(seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, options.signer))))
}

const newKeyPair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

/** A CA for one gateway. Its private key only ever exists in this process's memory. */
export function createCertificateAuthority(days = 7): CertificateAuthority {
  const { publicKey, privateKey } = newKeyPair()
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const subject = `evalsuite egress CA ${randomBytes(4).toString('hex')}`
  const cert = issue({
    subject,
    issuer: subject,
    publicKey,
    signer: privateKey,
    authorityKeyId: keyId(spki),
    days,
    extensions: [
      extension('2.5.29.19', true, seq(bool(true), integer(Buffer.from([0])))),
      // digitalSignature, keyCertSign, cRLSign
      extension('2.5.29.15', true, keyUsage(0x86)),
    ],
  })
  return { cert, key: privateKey, spki, subject }
}

/** A TLS server certificate for `host` (a DNS name or an IP address), signed by `ca`. */
export function issueServerCertificate(ca: CertificateAuthority, host: string): Certificate {
  const { publicKey, privateKey } = newKeyPair()
  const version = isIP(host)
  const altName = version
    ? der(0x87, Buffer.from(version === 4 ? host.split('.').map(Number) : ipv6Bytes(host)))
    : der(0x82, Buffer.from(host, 'ascii'))
  const cert = issue({
    subject: host,
    issuer: ca.subject,
    publicKey,
    signer: ca.key,
    authorityKeyId: keyId(ca.spki),
    days: 7,
    extensions: [
      extension('2.5.29.19', true, seq()),
      // digitalSignature
      extension('2.5.29.15', true, keyUsage(0x80)),
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, seq(altName)),
    ],
  })
  return { cert, key: privateKey }
}

function ipv6Bytes(address: string): number[] {
  const [head = '', tail = ''] = address.split('::')
  const parts = (s: string) => (s ? s.split(':') : [])
  const h = parts(head)
  const t = parts(tail)
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return groups.flatMap((g) => {
    const v = Number.parseInt(g, 16)
    return [v >> 8, v & 0xff]
  })
}
