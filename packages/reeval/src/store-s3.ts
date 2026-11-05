// `reeval/store/s3`: the history kept in an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO).
import { UsageError } from './errors.ts'
import type { S3StoreDescriptor } from './types.ts'

export type { S3StoreDescriptor, S3StoreEnv } from './types.ts'

/**
 * Recorded runs in an S3-compatible bucket, under `prefix` when one is given. The keys come from
 * the host's environment only (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
 * `AWS_SESSION_TOKEN`, or the variables `env` names); `env` can also name the variables the
 * endpoint, bucket and region are read from.
 */
export function s3(options: Omit<S3StoreDescriptor, 'kind'>): S3StoreDescriptor {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new UsageError(
      `s3() takes an options object like { bucket: 'my-runs' } (got ${JSON.stringify(options)})`,
    )
  }
  return { ...options, kind: 's3' }
}
