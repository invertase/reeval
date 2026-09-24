## Turn 1

> Build a Genkit JavaScript flow that accepts a meal idea and returns a structured recipe with a title, ingredient list, and numbered instructions. Configure it to use a supported model through environment-based credentials, and make the flow runnable locally with a sample request.

A Genkit JavaScript recipe flow is set up in the workspace. Here is what was added and how to run it.

## Project layout

| File | Purpose |
|------|---------|
| `src/index.js` | Genkit flow with Zod schemas |
| `src/run-sample.js` | Local runner with a sample meal idea |
| `.env.example` | Documents `GOOGLE_GENAI_API_KEY` |
| `package.json` | Dependencies and npm scripts |

## Flow

`recipeFlow` accepts `{ mealIdea: string }` and returns structured output:

- **title** — recipe name  
- **ingredients** — array of ingredient lines with quantities  
- **instructions** — ordered steps (numbered when printed by the sample runner)

The Google AI plugin reads credentials from the environment (`GOOGLE_GENAI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`).

## Run locally

1. **Get an API key** from [Google AI Studio](https://aistudio.google.com/apikey).

2. **Set the environment variable:**
   ```bash
   export GOOGLE_GENAI_API_KEY="your-api-key-here"
   ```

3. **Install and run the sample:**
   ```bash
   cd /es/workspace
   npm install
   npm start
   ```

   Or pass your own meal idea:
   ```bash
   node src/run-sample.js "spicy Korean bibimbap bowl"
   ```

4. **Optional — Genkit Developer UI:**
   ```bash
   npm run dev
   ```
   Then open the UI to inspect and test `recipeFlow` with traces.

Without an API key, `npm start` exits with a clear message pointing to `.env.example`.
