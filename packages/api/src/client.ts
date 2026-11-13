import type { z } from 'zod'
import { type CallOptions, type ClientOptions, type Send, Transport } from './http.ts'
import {
  CloudRun,
  CreatedRun,
  DeviceCode,
  DeviceToken,
  Me,
  type Org,
  OrgList,
  PlatformConfig,
  type Project,
  ProjectList,
  type ProviderKey,
  ProviderKeyAnswer,
  ProviderKeyList,
  type Secret,
  SecretAnswer,
  SecretList,
  SecretNames,
  Share,
  ShareList,
  StudioRunState,
  type User,
} from './schemas.ts'

/** An org and a project in it, by id. */
export type ProjectRef = { org: string; project: string }

/** The grant type a device sign-in redeems its code with (RFC 8628). */
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/**
 * The cloud platform's API, as the reeval CLI calls it. Every call takes {@link CallOptions} last
 * and fails with an `ApiError`.
 *
 * ```ts
 * const api = new ReevalClient({ baseUrl, auth: async () => token })
 * const secrets = await api.secrets.list({ org, project })
 * ```
 */
export class ReevalClient {
  readonly #t: Transport

  constructor(options: ClientOptions) {
    this.#t = new Transport(options)
  }

  /** The platform's URL, with a trailing `/`. */
  get baseUrl(): URL {
    return new URL(this.#t.base)
  }

  /** The `Authorization` header for a connection the client doesn't make, such as the event stream's. */
  authHeaders(): Promise<Record<string, string>> {
    return this.#t.authHeaders()
  }

  #get = async <S extends z.ZodType>(
    operation: string,
    url: URL,
    schema: S,
    options?: CallOptions,
  ): Promise<z.output<S>> => {
    const req: Send = { operation, method: 'GET', url, options }
    return this.#t.json(req, await this.#t.send(req), schema)
  }

  #project = ({ org, project }: ProjectRef, ...rest: string[]) =>
    ['api', 'orgs', org, 'projects', project, ...rest] as const

  readonly config = {
    /** What a client needs before it bundles a run for this platform. */
    get: (options?: CallOptions): Promise<PlatformConfig> =>
      this.#get('config.get', this.#t.url(['api', 'config']), PlatformConfig, options),
  }

  readonly me = {
    /** Who the token signs in as. */
    get: async (options?: CallOptions): Promise<User> =>
      (await this.#get('me.get', this.#t.url(['api', 'me']), Me, options)).user,
  }

  readonly auth = {
    /** Starts a device sign-in; sends no token. */
    deviceCode: async (a: { clientId: string }, options?: CallOptions): Promise<DeviceCode> => {
      const req: Send = {
        operation: 'auth.deviceCode',
        method: 'POST',
        url: this.#t.url(['api', 'auth', 'device', 'code']),
        body: { json: { client_id: a.clientId } },
        auth: false,
        options,
      }
      return this.#t.json(req, await this.#t.send(req), DeviceCode)
    },
    /**
     * Redeems a device code for a token; sends no token. Until the code is approved it fails
     * with `code` `authorization_pending` or `slow_down`, as RFC 8628 has it.
     */
    deviceToken: async (
      a: { clientId: string; deviceCode: string },
      options?: CallOptions,
    ): Promise<DeviceToken> => {
      const req: Send = {
        operation: 'auth.deviceToken',
        method: 'POST',
        url: this.#t.url(['api', 'auth', 'device', 'token']),
        body: {
          json: { grant_type: DEVICE_GRANT, device_code: a.deviceCode, client_id: a.clientId },
        },
        auth: false,
        options,
      }
      return this.#t.json(req, await this.#t.send(req), DeviceToken)
    },
    /** Revokes the token's session; one the platform already refuses counts as revoked. */
    signOut: async (options?: CallOptions): Promise<void> => {
      const res = await this.#t.send({
        operation: 'auth.signOut',
        method: 'POST',
        url: this.#t.url(['api', 'auth', 'sign-out']),
        headers: { origin: this.#t.base.origin },
        body: { json: {} },
        allow: [401],
        options,
      })
      await res.body?.cancel()
    },
  }

  readonly orgs = {
    /** The orgs the signed-in user is a member of. */
    list: async (options?: CallOptions): Promise<Org[]> =>
      (await this.#get('orgs.list', this.#t.url(['api', 'orgs']), OrgList, options)).orgs,
  }

  readonly projects = {
    list: async (a: { org: string }, options?: CallOptions): Promise<Project[]> =>
      (
        await this.#get(
          'projects.list',
          this.#t.url(['api', 'orgs', a.org, 'projects']),
          ProjectList,
          options,
        )
      ).projects,
  }

  readonly secrets = {
    /** The project's secrets, never their values. */
    list: async (a: ProjectRef, options?: CallOptions): Promise<Secret[]> =>
      (
        await this.#get(
          'secrets.list',
          this.#t.url(this.#project(a, 'secrets')),
          SecretList,
          options,
        )
      ).secrets,
    /**
     * Every name a run in the project gets a value for, and which of `reserved` the platform sets
     * itself.
     */
    names: (a: ProjectRef & { reserved?: readonly string[] }, options?: CallOptions) =>
      this.#get(
        'secrets.names',
        this.#t.url(this.#project(a, 'secret-names'), {
          reserved: a.reserved?.length ? a.reserved.join(',') : undefined,
        }),
        SecretNames,
        options,
      ),
    /** Adds or replaces a secret; `created` is true when there was none of that name. */
    set: async (
      a: ProjectRef & { name: string; value: string; mode?: string; hosts?: readonly string[] },
      options?: CallOptions,
    ): Promise<{ secret: Secret; created: boolean }> => {
      const req: Send = {
        operation: 'secrets.set',
        method: 'PUT',
        url: this.#t.url(this.#project(a, 'secrets', a.name)),
        body: {
          json: {
            value: a.value,
            ...(a.mode !== undefined && { mode: a.mode }),
            ...(a.hosts !== undefined && { hosts: a.hosts }),
          },
        },
        options,
      }
      const res = await this.#t.send(req)
      const { secret } = await this.#t.json(req, res, SecretAnswer)
      return { secret, created: res.status === 201 }
    },
    delete: async (a: ProjectRef & { name: string }, options?: CallOptions): Promise<void> => {
      const res = await this.#t.send({
        operation: 'secrets.delete',
        method: 'DELETE',
        url: this.#t.url(this.#project(a, 'secrets', a.name)),
        options,
      })
      await res.body?.cancel()
    },
  }

  readonly providers = {
    /** The org's model provider keys and every project's own. */
    list: async (a: { org: string }, options?: CallOptions): Promise<ProviderKey[]> =>
      (
        await this.#get(
          'providers.list',
          this.#t.url(['api', 'orgs', a.org, 'providers']),
          ProviderKeyList,
          options,
        )
      ).providers,
    /** Adds or replaces the org's key for `provider`, or `project`'s own. */
    set: async (
      a: { org: string; provider: string; key: string; project?: string },
      options?: CallOptions,
    ): Promise<{ provider: ProviderKey; created: boolean }> => {
      const req: Send = {
        operation: 'providers.set',
        method: 'PUT',
        url: this.#t.url(['api', 'orgs', a.org, 'providers', a.provider]),
        body: { json: { key: a.key, ...(a.project !== undefined && { projectId: a.project }) } },
        options,
      }
      const res = await this.#t.send(req)
      const { provider } = await this.#t.json(req, res, ProviderKeyAnswer)
      return { provider, created: res.status === 201 }
    },
    delete: async (
      a: { org: string; provider: string; project?: string },
      options?: CallOptions,
    ): Promise<void> => {
      const res = await this.#t.send({
        operation: 'providers.delete',
        method: 'DELETE',
        url: this.#t.url(['api', 'orgs', a.org, 'providers', a.provider], {
          projectId: a.project,
        }),
        options,
      })
      await res.body?.cancel()
    },
  }

  readonly runs = {
    /** Creates a cloud run in the project, for a bundle of this hash and size. */
    create: async (
      a: ProjectRef & { bundleSha256: string; bundleBytes: number },
      options?: CallOptions,
    ): Promise<CreatedRun> => {
      const req: Send = {
        operation: 'runs.create',
        method: 'POST',
        url: this.#t.url(this.#project(a, 'runs')),
        body: { json: { bundleSha256: a.bundleSha256, bundleBytes: a.bundleBytes } },
        options,
      }
      return this.#t.json(req, await this.#t.send(req), CreatedRun)
    },
    /**
     * Uploads the bundle to where `runs.create` said. The token goes only to the platform's own
     * origin: another origin's URL carries its own authorization.
     */
    uploadBundle: async (
      a: { upload: CreatedRun['upload']; bundle: Uint8Array | Blob },
      options?: CallOptions,
    ): Promise<void> => {
      const url = new URL(a.upload.url)
      if (!/^https?:$/.test(url.protocol)) {
        throw new TypeError(`the upload URL is an http or https URL (got ${url.protocol})`)
      }
      const method = a.upload.method.toUpperCase()
      if (method !== 'PUT' && method !== 'POST') {
        throw new TypeError(`the upload method is PUT or POST (got ${a.upload.method})`)
      }
      const res = await this.#t.send({
        operation: 'runs.uploadBundle',
        method,
        url,
        body: { bytes: a.bundle, contentType: 'application/gzip' },
        auth: url.origin === this.#t.base.origin,
        options,
      })
      await res.body?.cancel()
    },
    start: async (a: { run: string }, options?: CallOptions): Promise<void> => {
      const res = await this.#t.send({
        operation: 'runs.start',
        method: 'POST',
        url: this.#t.url(['api', 'runs', a.run, 'start']),
        options,
      })
      await res.body?.cancel()
    },
    get: (a: { run: string }, options?: CallOptions): Promise<CloudRun> =>
      this.#get('runs.get', this.#t.url(['api', 'runs', a.run]), CloudRun, options),
    /** Asks the run to stop; it ends once its attempts have. */
    cancel: async (a: { run: string }, options?: CallOptions): Promise<void> => {
      const res = await this.#t.send({
        operation: 'runs.cancel',
        method: 'POST',
        url: this.#t.url(['api', 'runs', a.run, 'cancel']),
        options,
      })
      await res.body?.cancel()
    },
    /** The run's event stream, which `reeval attach` follows with {@link ReevalClient.authHeaders}. */
    eventsUrl: (a: { run: string }): URL => this.#t.url(['api', 'runs', a.run, 'events']),
    /** The run's files as a gzipped tar, unread; null when the run has none. */
    files: async (a: { run: string }, options?: CallOptions): Promise<Response | null> => {
      const res = await this.#t.send({
        operation: 'runs.files',
        method: 'GET',
        url: this.#t.url(['api', 'runs', a.run, 'artifacts', 'files.tar.gz']),
        accept: 'application/gzip',
        allow: [404],
        options,
      })
      if (res.status !== 404) return res
      await res.body?.cancel()
      return null
    },
  }

  readonly studio = {
    runs: {
      /** How the project's copy of a recorded run stands; null when it has none. */
      get: async (a: ProjectRef & { run: string }, options?: CallOptions) => {
        const req: Send = {
          operation: 'studio.runs.get',
          method: 'GET',
          url: this.#t.url(this.#project(a, 'studio', 'runs', a.run)),
          allow: [404],
          options,
        }
        const res = await this.#t.send(req)
        if (res.status !== 404) return this.#t.json(req, res, StudioRunState)
        await res.body?.cancel()
        return null
      },
      /** Uploads a recorded run's archive (a zip) as the project's copy of it. */
      put: async (
        a: ProjectRef & { run: string; archive: Uint8Array | Blob },
        options?: CallOptions,
      ): Promise<StudioRunState> => {
        const req: Send = {
          operation: 'studio.runs.put',
          method: 'PUT',
          url: this.#t.url(this.#project(a, 'studio', 'runs', a.run)),
          body: { bytes: a.archive, contentType: 'application/zip' },
          options,
        }
        return this.#t.json(req, await this.#t.send(req), StudioRunState)
      },
    },
    shares: {
      /** The project's shares, or one run's. */
      list: async (a: ProjectRef & { run?: string }, options?: CallOptions) =>
        (
          await this.#get(
            'studio.shares.list',
            this.#t.url(this.#project(a, 'studio', 'shares'), { runId: a.run }),
            ShareList,
            options,
          )
        ).shares,
      /** Shares a run the project has; `created` is false when that share already existed. */
      create: async (
        a: ProjectRef & { run: string; type: 'report' | 'full'; scope: 'team' | 'public' },
        options?: CallOptions,
      ): Promise<{ share: Share; created: boolean }> => {
        const req: Send = {
          operation: 'studio.shares.create',
          method: 'POST',
          url: this.#t.url(this.#project(a, 'studio', 'shares')),
          body: { json: { runId: a.run, type: a.type, scope: a.scope } },
          options,
        }
        const res = await this.#t.send(req)
        return { share: await this.#t.json(req, res, Share), created: res.status === 201 }
      },
      revoke: async (a: ProjectRef & { id: string }, options?: CallOptions): Promise<void> => {
        const res = await this.#t.send({
          operation: 'studio.shares.revoke',
          method: 'DELETE',
          url: this.#t.url(this.#project(a, 'studio', 'shares', a.id)),
          options,
        })
        await res.body?.cancel()
      },
    },
    analysis: {
      /** Uploads a saved analysis of a run the platform has. */
      put: async (a: { run: string; analysis: Uint8Array }, options?: CallOptions) => {
        const res = await this.#t.send({
          operation: 'studio.analysis.put',
          method: 'PUT',
          url: this.#t.url(['api', 'v1', 'runs', a.run, 'analysis']),
          body: { bytes: a.analysis, contentType: 'application/json' },
          options,
        })
        await res.body?.cancel()
      },
    },
  }
}
