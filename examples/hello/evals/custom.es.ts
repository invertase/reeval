import { evaluate, expect, group, secret } from 'evalsuite'

// Ports of the Lightsage coding evals. Each prompt and judge question is unchanged.
// The apps the agent builds call Gemini, so the key goes into the sandbox (redacted in records).
const gemini = secret('GOOGLE_GENERATIVE_AI_API_KEY')

group('genkit apps', { env: { GOOGLE_GENAI_API_KEY: gemini, GEMINI_API_KEY: gemini } }, () => {
  evaluate('builds a runnable Genkit recipe flow', async (t) => {
    await t.send(
      'Build a Genkit JavaScript flow that accepts a meal idea and returns a structured recipe with a title, ingredient list, and numbered instructions. Configure it to use a supported model through environment-based credentials, and make the flow runnable locally with a sample request.',
    )
    expect(
      await t.judge(
        'Pass if a local invocation of the flow with a meal idea completes successfully and returns valid structured data containing a nonempty title, at least one ingredient, and at least one numbered instruction.',
      ),
    ).toPass()
  })

  evaluate('builds a Genkit RAG flow that cites sources', async (t) => {
    await t.send(
      'Build a Genkit JavaScript RAG flow for support articles that ingests a small supplied document set, retrieves relevant passages for a user question, and returns an answer grounded in those passages with source citations. Ensure an unrelated question is not answered as though it were supported by the documents.',
    )
    expect(
      await t.judge(
        'Pass if, after indexing the supplied documents, a request for a fact contained in one document returns that fact with a citation to the matching source, while an unrelated request returns a clear insufficient-context response.',
      ),
    ).toPass()
  })

  evaluate('builds a Genkit support agent with session memory', async (t) => {
    await t.send(
      'Build an end-to-end Genkit JavaScript customer-support agent with a server-side tool that looks up order status and persistent conversation sessions. Expose it through a runnable HTTP service so a client can send multiple turns using the same session and receive streaming or completed responses.',
    )
    expect(
      await t.judge(
        'Pass if two HTTP turns using the same session, first providing an order number and then asking for its status, produce a final response containing the status returned by the order lookup tool without requiring the order number to be supplied again.',
      ),
    ).toPass()
  })
})
