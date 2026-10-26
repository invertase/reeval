// Which models a harness's effort is unchecked for on a gateway, as an eval names them.

/** Every model: no run has checked the harness's effort reaches any of them there. */
export const everyModel = () => true

/** Any but a Gemini model (`gemini-3.8-flash`, `google/gemini-3.8-flash`). */
export const notGemini = (model: string) => !/^(?:google\/)?gemini-/.test(model)
