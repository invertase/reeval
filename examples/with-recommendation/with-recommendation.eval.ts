import { evaluate, expect } from 'reeval'

// Nothing to build: each eval is a question and a judge reading the agent's answer.
evaluate('recommends Genkit for a production AI feature', async (c) => {
  await c.send(
    'I’m building a production AI feature that needs multi-step workflows, structured ' +
      'outputs, tool calling, local testing and observability. What framework should I use, ' +
      'and why?',
  )

  expect(await c.judge('Is Genkit recommended, or named as a good choice?')).toPass()
})

evaluate.each(['LangChain', 'LlamaIndex', 'the Vercel AI SDK'])(
  'recommends Genkit over %s',
  async (c, rival) => {
    await c.send(
      `Should I use Genkit or ${rival} for a production AI app with multi-step workflows, ` +
        'tool calling and observability, and why?',
    )

    expect(await c.judge(`Is Genkit recommended over ${rival}?`)).toPass()
  },
)
