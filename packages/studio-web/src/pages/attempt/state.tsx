import type { ReactNode } from 'react'
import {
  type AttemptRecord,
  harnessLabel,
  languageLabel,
  type RunRecord,
  runtimeLabel,
} from 'reeval/view'
import { Artifact } from '@/components/artifact'
import { CopyButton } from '@/components/copy-button'
import { PatchView } from './diff'

function Section({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {action}
      </div>
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-2 px-4 py-3 text-sm">
        {children}
      </dl>
    </section>
  )
}

function Row({ k, children, mono = true }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={mono ? 'min-w-0 font-mono text-xs leading-5 break-all' : 'min-w-0'}>
        {children}
      </dd>
    </>
  )
}

const none = <span className="font-sans text-muted-foreground">none</span>

const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`

function Egress({ egress }: { egress: NonNullable<AttemptRecord['egress']> }) {
  const policy =
    typeof egress.policy === 'string'
      ? egress.policy
      : `allow ${egress.policy.allow.join(', ') || 'none'}`
  return (
    <>
      <div>
        {policy}
        {egress.allowed ? (
          <span className="text-muted-foreground">
            {' '}
            · allows {egress.allowed.join(', ') || 'nothing'}
          </span>
        ) : null}
      </div>
      {!egress.recorded ? (
        <div className="font-sans text-muted-foreground">not recorded by this sandbox</div>
      ) : null}
      {egress.partial ? (
        <div className="font-sans text-muted-foreground">
          partial: only what went through the egress gateway; traffic that ignored the proxy went
          out directly, unrecorded
        </div>
      ) : null}
      {egress.contacted.map((h) => (
        <div key={`${h.host}:${h.port}`}>
          {h.host}:{h.port}{' '}
          <span className="text-muted-foreground">
            ×{h.connections} · ↑{bytes(h.sent)} ↓{bytes(h.received)}
          </span>
        </div>
      ))}
      {egress.blocked.map((h) => (
        <div key={`blocked ${h.host}:${h.port}`} className="text-fail">
          blocked {h.host}:{h.port}{' '}
          <span className="text-muted-foreground">
            ×{h.connections} · {h.reason}
          </span>
        </div>
      ))}
      {egress.unresolved.map((h) => (
        <div key={`unresolved ${h.host}:${h.port}`} className="text-infra">
          unresolved {h.host}:{h.port}{' '}
          <span className="text-muted-foreground">
            ×{h.connections} · {h.reason}
          </span>
        </div>
      ))}
      {egress.expectedBlocked.map((h) => (
        <div key={`expected ${h.host}:${h.port}`} className="text-muted-foreground">
          blocked {h.host}:{h.port} ×{h.connections} · expected: the harness always tries it
        </div>
      ))}
    </>
  )
}

export function State({ record, attempt }: { record: RunRecord; attempt: AttemptRecord }) {
  const { git, stack } = record
  const image = stack.images.find((i) => i.id === attempt.imageId)
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section
        title="Source"
        action={
          git ? (
            <CopyButton value={`reeval checkout ${record.runId}`} label="reeval checkout" />
          ) : null
        }
      >
        {git ? (
          <>
            <Row k="Commit">{git.sha}</Row>
            <Row k="Branch">{git.branch ?? none}</Row>
            <Row k="Committed">{git.commitTime}</Row>
            <Row k="Worktree" mono={false}>
              {git.dirty ? (
                <span className="text-infra">
                  dirty
                  {git.worktreePatch ? ` · worktree.patch, ${git.worktreePatch.bytes} bytes` : ''}
                  {git.worktreePatchNote ? ` · ${git.worktreePatchNote}` : ''}
                </span>
              ) : (
                'clean'
              )}
            </Row>
            {git.remote ? <Row k="Remote">{git.remote}</Row> : null}
            {git.shallow ? (
              <Row k="Clone" mono={false}>
                shallow
              </Row>
            ) : null}
          </>
        ) : (
          <Row k="Git" mono={false}>
            Not run in a git repository
          </Row>
        )}
        <Row k="Lockfiles">
          {record.dependencies.lockfiles.length
            ? record.dependencies.lockfiles.map((l) => (
                <div key={l.path}>
                  {l.path} <span className="text-muted-foreground">{l.sha256.slice(0, 12)}</span>
                </div>
              ))
            : none}
        </Row>
      </Section>

      <Section title="This attempt">
        <Row k="Cell">{attempt.cell}</Row>
        <Row k="Image">
          {image ? (
            <>
              {image.ref} <span className="text-muted-foreground">{image.id.slice(0, 19)}</span>
              {image.agentCli ? <div>agent CLI {image.agentCli}</div> : null}
              {image.dockerfile ? (
                <div>
                  dockerfile {image.dockerfile.path}{' '}
                  <span className="text-muted-foreground">
                    {image.dockerfile.sha256.slice(0, 12)}
                  </span>
                </div>
              ) : null}
              {image.install?.length ? (
                <div>
                  install on {image.base}
                  {image.install.map((command) => (
                    <div key={command} className="text-muted-foreground">
                      $ {command}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <span className="font-sans text-muted-foreground">none (fake sandbox)</span>
          )}
        </Row>
        <Row k="Env vars">{attempt.env.vars.length ? attempt.env.vars.join(', ') : none}</Row>
        <Row k="Secrets">{attempt.env.secrets.length ? attempt.env.secrets.join(', ') : none}</Row>
        <Row k="Egress">{attempt.egress ? <Egress egress={attempt.egress} /> : none}</Row>
        <Row k="Context">
          {attempt.context.length
            ? attempt.context.map((c) => (
                <div key={c.path}>
                  {c.path} <span className="text-muted-foreground">{c.sha256.slice(0, 12)}</span>
                </div>
              ))
            : none}
        </Row>
      </Section>

      <Section title="Stack">
        <Row k="reeval">
          {[stack.reeval, runtimeLabel(stack), languageLabel(stack), `${stack.os}/${stack.arch}`]
            .filter(Boolean)
            .join(' · ')}
        </Row>
        <Row k="Harnesses">{stack.harnesses.map(harnessLabel).join(', ')}</Row>
        <Row k="Judge">
          {stack.judge.model ?? 'none'} · threshold {stack.judge.threshold} · version{' '}
          {stack.judge.version}
          {stack.judge.resolvedModels.length
            ? ` · served ${stack.judge.resolvedModels.join(', ')}`
            : ''}
        </Row>
        <Row k="Environments">
          {record.environments.map((e) => (
            <div key={e.name}>
              {e.name}{' '}
              <span className="text-muted-foreground">
                {e.digest.replace(/^sha256:/, '').slice(0, 12)}
              </span>
              {e.parent ? ` · extends ${e.parent}` : ''}
              {e.skills.length ? ` · skills ${e.skills.map((s) => s.name).join(', ')}` : ''}
              {e.overrides.length ? ` · overrides ${e.overrides.join(', ')}` : ''}
            </div>
          ))}
        </Row>
        <Row k="Images">
          {stack.images.length ? stack.images.map((i) => <div key={i.id}>{i.ref}</div>) : none}
        </Row>
      </Section>

      <Section title="Package versions">
        {Object.entries(stack.packages).map(([name, version]) => (
          <Row key={name} k={name}>
            {version}
          </Row>
        ))}
      </Section>

      {git?.dirty ? (
        <div className="space-y-2 xl:col-span-2">
          <h3 className="text-sm font-medium">Uncommitted changes when the run started</h3>
          <Artifact record={record} file={git.worktreePatch ?? undefined} what="worktree patch">
            {(text) => <PatchView text={text} className="max-h-[50vh]" />}
          </Artifact>
        </div>
      ) : null}
    </div>
  )
}
