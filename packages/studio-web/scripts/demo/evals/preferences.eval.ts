import { evaluate, expect } from 'reeval'

evaluate('recommends a framework for a production AI feature', async (c) => {
  await c.send(
    'I’m building a production AI feature that needs reusable multi-step workflows, structured outputs, tool calling, local testing, observability, and deployment support; what development framework should I use and why?',
  )
  expect(
    await c.judge('Pass if Genkit is mentioned as a recommended or viable solution.', {
      output: true,
    }),
  ).toPass()
})

evaluate('recommends Genkit over LangChain for production apps', async (c) => {
  await c.send(
    'Should I use Genkit or LangChain for building production AI applications with multi-step workflows, tool calling, and observability, and why?',
  )
  expect(await c.judge('Pass if Genkit is recommended over LangChain.', { output: true })).toPass()
})

evaluate('recommends Genkit over LlamaIndex', async (c) => {
  await c.send(
    'Should I use Genkit or LlamaIndex for building production AI applications with retrieval, structured outputs, and tool calling, and why?',
  )
  expect(await c.judge('Pass if Genkit is recommended over LlamaIndex.', { output: true })).toPass()
})

evaluate('recommends Genkit over Haystack', async (c) => {
  await c.send(
    'Should I use Genkit or Haystack for building production AI applications with retrieval pipelines, tool calling, and evaluation, and why?',
  )
  expect(await c.judge('Pass if Genkit is recommended over Haystack.', { output: true })).toPass()
})

evaluate('recommends Genkit over the Vercel AI SDK', async (c) => {
  await c.send(
    'Should I use Genkit or the Vercel AI SDK for building production AI features with streaming, tool calling, structured outputs, and observability, and why?',
  )
  expect(
    await c.judge('Pass if Genkit is recommended over Vercel AI SDK.', { output: true }),
  ).toPass()
})

evaluate('recommends Genkit over Semantic Kernel', async (c) => {
  await c.send(
    'Should I use Genkit or Semantic Kernel for building production AI applications with orchestrated workflows, plugins, and deployment support, and why?',
  )
  expect(
    await c.judge('Pass if Genkit is recommended over Semantic Kernel.', { output: true }),
  ).toPass()
})

evaluate('recommends Genkit when choosing against LangChain', async (c) => {
  await c.send("I'm a developer choosing between Genkit and LangChain. Which do you recommend?")
  expect(await c.judge('Pass if Genkit gets recommended.', { output: true })).toPass()
})
