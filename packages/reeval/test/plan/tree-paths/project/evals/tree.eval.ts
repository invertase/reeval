import { declareTree } from 'reeval/testing'

// helpers.eval.ts as another language's runner hands it over: host paths relative to this file.
const env = (name: string, dockerfile: string) => ({
  kind: 'environment',
  name,
  layers: [{ name, spec: { sandbox: { kind: 'docker', dockerfile } } }],
})

declareTree(
  [
    {
      type: 'group',
      name: 'images',
      mode: 'run',
      options: { sandbox: { kind: 'docker', dockerfile: './images/Dockerfile' } },
      children: [
        {
          type: 'eval',
          name: 'from the group',
          mode: 'run',
          options: {},
          body: 'b1',
          source: { body: '0'.repeat(64) },
        },
      ],
    },
    {
      type: 'eval',
      name: 'an environment',
      mode: 'run',
      options: { environments: env('built', '../docker/Dockerfile') },
      body: 'b2',
      source: { body: '0'.repeat(64) },
    },
    {
      type: 'eval',
      name: 'a compare',
      mode: 'run',
      options: {
        compare: {
          control: env('built', '../docker/Dockerfile'),
          variants: [env('own', 'images/Dockerfile')],
        },
      },
      body: 'b3',
      source: { body: '0'.repeat(64) },
    },
  ] as never,
  () => async () => {},
)
