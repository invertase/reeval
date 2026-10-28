import { evaluate, expect, group } from 'reeval'
import { MODULES } from '../agent/modules.mjs'

group('modules', { runs: 2 }, () => {
  for (const name of MODULES) {
    evaluate(`writes ${name}`, async (c) => {
      await c.send(`Write src/${name}.js exporting an empty ${name} list, with a doc comment.`)
      expect(await c.readFile(`src/${name}.js`), 'exports the list').toContain('export')
      const verdict = await c.judge(`Is src/${name}.js small, documented and readable?`, {
        contents: [`src/${name}.js`],
      })
      expect(verdict, 'readable').toPass()
    })
  }
})
