import { defineEnvironment, evaluate, expect } from 'reeval'

// The page in ./project is the control; the variant adds Anthropic's published brand-guidelines
// skill, fetched from its repository at a pinned commit.
const page = defineEnvironment('page', ({ directory }) => ({ files: directory('./project') }))
const withSkill = page.extendEnvironment('brand-guidelines', ({ skill }) => ({
  skills: [
    skill.git('github:anthropics/skills', {
      ref: 'dbd4588f9e1033efb41dad4bef2f7947c8993d44',
      path: 'skills',
      only: ['brand-guidelines'],
    }),
  ],
}))

evaluate(
  "styles the page in Anthropic's brand",
  // Four tries a side is the fewest that gives a verdict; the variant passes on 3 of 4 or more.
  { compare: { control: page, variants: [withSkill] }, runs: 4, gate: { passRate: 0.75 } },
  async (c) => {
    await c.send(
      "Give index.html Anthropic's look: write styles.css with Anthropic's brand colors and " +
        'fonts, and link it from index.html.',
    )

    await expect(c, 'links styles.css').toHaveFile('index.html', /href="styles\.css"/)
    await expect(c, 'brand orange').toHaveFile('styles.css', /#d97757/i)
    await expect(c, 'brand fonts').toHaveFile('styles.css', /Poppins[\s\S]*Lora|Lora[\s\S]*Poppins/)
  },
)
