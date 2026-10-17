// A three-arm skill study shaped like the FirebaseUI one that motivated reeval's study analysis:
// no skill (the control), a current skill that shows only email sign-in, and a new skill whose
// reference documents the social button too. The fake agent reads what its skill points at,
// digs in node_modules when nothing does, and writes social sign-in unless the current skill is
// all it has. Per-call fake judges score from the diff: Social OAuth separates the arms,
// Anonymous upgrade and MFA fail everywhere (the prompt never asks for them), the rest pass.
// Compare questions go to the first-shown attempt whenever the two arms wrote the same thing.

const SKILLS = '~/.agents/skills'
const email = `import { EmailSignInForm } from '@fui/react'
import { signOut } from './auth'
export default function App() {
  return <main className="auth"><EmailSignInForm onSignIn={go} /><button onClick={signOut}>Sign out</button></main>
}
`
const full = email
  .replace('<EmailSignInForm', '<GoogleSignInButton onSignIn={go} /><EmailSignInForm')
  .replace('import { EmailSignInForm }', 'import { EmailSignInForm, GoogleSignInButton }')
const b64 = (t: string) => Buffer.from(t).toString('base64')

export type StudyOptions = {
  /** The compare's gate; a study sets `'none'`. */
  gate?: 'none' | 'variants'
  runs?: number
  /** `analysis` config body, after `model:`'s fake. */
  output?: string
  instructions?: string
}

export function studyFiles(options: StudyOptions = {}): Record<string, string> {
  const gate = options.gate === undefined ? '' : `gate: '${options.gate}',`
  return {
    'reeval.config.ts': `import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeAnalysis, fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'
export default defineConfig({
  harness: fakeHarness({
    script: [[
      { exec: 'cat ${SKILLS}/*/SKILL.md 2>/dev/null || true' },
      { exec: 'cat ${SKILLS}/fui-new/references/react.md 2>/dev/null || true' },
      { exec: '[ -d ${SKILLS}/fui-new ] || cat node_modules/@fui/react/index.d.ts' },
      { exec: '[ -d ${SKILLS}/fui-current ] || find . -maxdepth 3 -not -path "*/node_modules/*" -type f' },
      { exec: 'if [ -d ${SKILLS}/fui-current ]; then echo ${b64(email)} | base64 -d > src/App.tsx; else echo ${b64(full)} | base64 -d > src/App.tsx; fi' },
    ]],
    text: 'Shipped sign-in.',
  }),
  sandbox: fakeSandbox({ dir: new URL('./sandboxes', import.meta.url) }),
  judge: { model: fakeJudge({ score: 0.9 }) },
  record: 'always',
  analysis: {
    ${options.instructions ? `instructions: ${JSON.stringify(options.instructions)},` : ''}
    model: fakeAnalysis({
      vote: (p) => (p.a.includes('GoogleSignInButton') === p.b.includes('GoogleSignInButton') || p.a.includes('GoogleSignInButton') ? 'A' : 'B'),
      output: ${options.output ?? "{ tldr: 'fake', whatHappened: [], results: [], why: [], anomalies: [], actions: [], confidence: { overall: 'low', why: 'fake' } }"},
    }),
  },
})
`,
    'evals/environments.ts': `import { defineEnvironment } from 'reeval'
const dts = [
  'export declare function EmailSignInForm(p: { onSignIn(): void }): JSX.Element',
  'export declare function GoogleSignInButton(p: { onSignIn(): void }): JSX.Element',
].join('\\n')
export const noSkill = defineEnvironment('no-skill', {
  files: {
    '.gitignore': 'node_modules/\\n',
    'src/App.tsx': 'export default function App() { return null }\\n',
    'node_modules/@fui/react/index.d.ts': dts + '\\n',
  },
})
export const currentSkill = noSkill.extendEnvironment('current-skill', ({ skill }) => ({
  skills: [skill.local('../skills/fui-current')],
}))
export const newSkill = noSkill.extendEnvironment('new-skill', ({ skill }) => ({
  skills: [skill.local('../skills/fui-new')],
}))
`,
    'evals/auth.eval.ts': `import { evaluate, expect, group } from 'reeval'
import { fakeJudge } from 'reeval/judge'
import { currentSkill, newSkill, noSkill } from './environments.ts'
const RUBRIC: Array<[string, string, RegExp | null]> = [
  ['Email sign-in', 'Does it implement email sign-in?', /EmailSignInForm/],
  ['Social OAuth', 'Does it implement social sign-in?', /GoogleSignInButton/],
  ['Anonymous upgrade', 'Does it upgrade an anonymous user?', null],
  ['MFA', 'Does it implement multi-factor sign-in?', null],
]
const judgeOf = (has: RegExp | null) =>
  fakeJudge({ score: (s) => (has?.test(JSON.stringify(s)) ? 0.94 : 0.12) })
group(
  'auth skill',
  {
    compare: {
      baseline: noSkill,
      variants: [currentSkill, newSkill],
      ${gate}
      across: 'environment',
      questions: ['Which sign-in has the better UX?', 'Which follows the library docs more closely?'],
    },
    runs: ${options.runs ?? 3},
  },
  () => {
    evaluate('ships a complete auth experience', async (c) => {
      await c.send('Ship a complete authentication experience for this app.')
      await expect.soft(c.exec('test -s src/App.tsx'), 'build').toSucceed()
      for (const [name, q, has] of RUBRIC) {
        expect.soft(await c.judge(q, { model: judgeOf(has) }), name).toPass()
      }
    })
  },
)
`,
    'skills/fui-current/SKILL.md': `---
name: fui-current
description: FirebaseUI for React. Use when adding sign-in.
---
# FirebaseUI
\`\`\`tsx
import { EmailSignInForm } from '@fui/react'
<EmailSignInForm onSignIn={...} />
\`\`\`
`,
    'skills/fui-new/SKILL.md': `---
name: fui-new
description: FirebaseUI for React. Use when adding sign-in.
---
# FirebaseUI
Routing index. React: read references/react.md for component props and social sign-in.
`,
    'skills/fui-new/references/react.md': `# React components
| Component | Props |
|---|---|
| EmailSignInForm | onSignIn |
| GoogleSignInButton | onSignIn |
Compose \`<GoogleSignInButton />\` beside \`<EmailSignInForm />\`.
`,
    'skills/fui-new/references/angular.md': '# Angular\nNot used by a React app.\n',
  }
}
