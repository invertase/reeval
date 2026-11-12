// A real S3 API for the store tests' Docker tier: MinIO in a container on a loopback port, with
// one bucket. The MinIO project no longer publishes images, so this is pigsty's build of it,
// pinned by digest.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { S3Client } from '@bradenmacdonald/s3-lite-client'

const exec = promisify(execFile)

export const MINIO_IMAGE =
  'pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372'

/** Whether `docker` answers, so the tier can run. */
export async function dockerRunning(): Promise<boolean> {
  return exec('docker', ['info', '--format', '{{.ServerVersion}}']).then(
    () => true,
    () => false,
  )
}

export type Minio = {
  url: string
  bucket: string
  accessKey: string
  secretKey: string
  client: S3Client
  /** Every key under `prefix`, sorted. */
  keys(prefix?: string): Promise<string[]>
  read(key: string): Promise<string>
  close(): Promise<void>
}

export async function startMinio(bucket = 'reeval-runs'): Promise<Minio> {
  const accessKey = 'reeval-test'
  const secretKey = 'reeval-test-secret'
  const { stdout } = await exec('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::9000',
    '-e',
    `MINIO_ROOT_USER=${accessKey}`,
    '-e',
    `MINIO_ROOT_PASSWORD=${secretKey}`,
    MINIO_IMAGE,
    'server',
    '/data',
  ])
  const id = stdout.trim()
  const close = async () => {
    await exec('docker', ['rm', '-f', id]).catch(() => {})
  }
  try {
    const port = (await exec('docker', ['port', id, '9000/tcp'])).stdout.trim().split(':').at(-1)
    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60_000
    for (;;) {
      const ready = await fetch(`${url}/minio/health/ready`).then(
        (r) => r.ok,
        () => false,
      )
      if (ready) break
      if (Date.now() > deadline) throw new Error(`MinIO at ${url} wasn't ready after 60s`)
      await new Promise((r) => setTimeout(r, 250))
    }
    const client = new S3Client({
      endPoint: url,
      region: 'us-east-1',
      bucket,
      accessKey,
      secretKey,
    })
    // MinIO answers its readiness check before it has initialized its object layer, and refuses
    // requests with XMinioServerNotInitialized (503) until then.
    for (;;) {
      try {
        await client.makeBucket(bucket)
        break
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code !== 'XMinioServerNotInitialized' || Date.now() > deadline) throw error
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    return {
      url,
      bucket,
      accessKey,
      secretKey,
      client,
      async keys(prefix = '') {
        const keys: string[] = []
        for await (const o of client.listObjects({ prefix })) keys.push(o.key)
        return keys.sort()
      },
      async read(key) {
        return (await client.getObject(key)).text()
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
