// The answers the client reads, as far as its callers read them. Each object is loose, so a field
// the platform adds passes through, and status-like fields are open strings where a value the
// platform adds later shouldn't make an older client refuse the answer.
import { z } from 'zod'

export const PlatformConfig = z.looseObject({
  /** The model gateway base URL the platform's runs use; null when it has none. */
  gatewayBaseUrl: z.string().nullable().optional(),
})
export type PlatformConfig = z.output<typeof PlatformConfig>

export const User = z.looseObject({
  id: z.string().optional(),
  email: z.string(),
  name: z.string().nullable().optional(),
})
export type User = z.output<typeof User>

export const Me = z.looseObject({ user: User })

/** The device authorization grant's start (RFC 8628). */
export const DeviceCode = z.looseObject({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().optional(),
  interval: z.number().optional(),
})
export type DeviceCode = z.output<typeof DeviceCode>

export const DeviceToken = z.looseObject({ access_token: z.string().min(1) })
export type DeviceToken = z.output<typeof DeviceToken>

export const Org = z.looseObject({ id: z.string(), slug: z.string(), name: z.string() })
export type Org = z.output<typeof Org>

export const Project = z.looseObject({ id: z.string(), slug: z.string(), name: z.string() })
export type Project = z.output<typeof Project>

const UpdatedBy = z.looseObject({ id: z.string(), email: z.string() }).nullable().optional()

/** A secret as the platform lists it: never its value. */
export const Secret = z.looseObject({
  name: z.string(),
  /** `brokered`, `sandbox` or `readable`. */
  mode: z.string(),
  hosts: z.array(z.string()).nullable().optional(),
  version: z.number(),
  updatedAt: z.string().optional(),
  updatedBy: UpdatedBy,
})
export type Secret = z.output<typeof Secret>

export const SecretNames = z.looseObject({
  /** Every name a run in the project gets a value for. */
  names: z.array(z.string()),
  /** The names asked about that the platform sets itself, which no run can take as secrets. */
  reserved: z.array(z.string()).default([]),
})
export type SecretNames = z.output<typeof SecretNames>

/** A model provider's key as the platform lists it: its last four characters at most. */
export const ProviderKey = z.looseObject({
  provider: z.string(),
  /** Null for the org's own key, else the project whose key it is. */
  projectId: z.string().nullable(),
  last4: z.string().optional(),
  version: z.number(),
  updatedAt: z.string().optional(),
  updatedBy: UpdatedBy,
})
export type ProviderKey = z.output<typeof ProviderKey>

export const CreatedRun = z.looseObject({
  runId: z.string().min(1),
  status: z.string().optional(),
  /** Where the bundle goes; another origin's URL carries its own authorization. */
  upload: z.looseObject({ url: z.url(), method: z.string().default('PUT') }),
})
export type CreatedRun = z.output<typeof CreatedRun>

export const CloudRun = z.looseObject({
  id: z.string(),
  status: z.string(),
  error: z.looseObject({ code: z.string(), message: z.string() }).nullable().optional(),
  /** The code from the run's latest `exit` event; null while it runs. */
  exitCode: z.number().int().nullable().optional(),
})
export type CloudRun = z.output<typeof CloudRun>

/** How the cloud project's copy of a recorded run stands. */
export const StudioRunState = z.looseObject({
  revision: z.number(),
  status: z.enum(['pending', 'ready', 'failed']),
  error: z.string().nullable().optional(),
})
export type StudioRunState = z.output<typeof StudioRunState>

export const Share = z.looseObject({
  id: z.string(),
  url: z.string(),
  runId: z.string(),
  /** `report` or `full`. */
  type: z.string(),
  /** `team` or `public`. */
  scope: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable().optional(),
})
export type Share = z.output<typeof Share>

export const OrgList = z.looseObject({ orgs: z.array(Org) })
export const ProjectList = z.looseObject({ projects: z.array(Project) })
export const SecretList = z.looseObject({ secrets: z.array(Secret) })
export const SecretAnswer = z.looseObject({ secret: Secret })
export const ProviderKeyList = z.looseObject({ providers: z.array(ProviderKey) })
export const ProviderKeyAnswer = z.looseObject({ provider: ProviderKey })
export const ShareList = z.looseObject({ shares: z.array(Share) })
