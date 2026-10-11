import { evaluate, expect, group } from 'reeval'
import { genkit } from './environments.ts'

// Each prompt and judge question is unchanged.
// The apps the agent builds call Gemini, so the genkit environment puts the key in the sandbox
// (redacted in records).
group('genkit apps', { environment: genkit }, () => {
  evaluate('builds a runnable Genkit recipe flow', async (c) => {
    await c.send(
      'Build a Genkit JavaScript flow that accepts a meal idea and returns a structured recipe with a title, ingredient list, and numbered instructions. Configure it to use a supported model through environment-based credentials, and make the flow runnable locally with a sample request.',
    )
    expect(
      await c.judge(
        'Pass if a local invocation of the flow with a meal idea completes successfully and returns valid structured data containing a nonempty title, at least one ingredient, and at least one numbered instruction.',
      ),
    ).toPass()
  })

  evaluate('builds a Genkit RAG flow that cites sources', async (c) => {
    await c.send(
      'Build a Genkit JavaScript RAG flow for support articles that ingests a small supplied document set, retrieves relevant passages for a user question, and returns an answer grounded in those passages with source citations. Ensure an unrelated question is not answered as though it were supported by the documents.',
    )
    expect(
      await c.judge(
        'Pass if, after indexing the supplied documents, a request for a fact contained in one document returns that fact with a citation to the matching source, while an unrelated request returns a clear insufficient-context response.',
      ),
    ).toPass()
  })

  evaluate('builds a Genkit support agent with session memory', async (c) => {
    await c.send(
      'Build an end-to-end Genkit JavaScript customer-support agent with a server-side tool that looks up order status and persistent conversation sessions. Expose it through a runnable HTTP service so a client can send multiple turns using the same session and receive streaming or completed responses.',
    )
    expect(
      await c.judge(
        'Pass if two HTTP turns using the same session, first providing an order number and then asking for its status, produce a final response containing the status returned by the order lookup tool without requiring the order number to be supplied again.',
      ),
    ).toPass()
  })
})
