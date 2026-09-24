import { evaluate } from 'evalsuite'
evaluate('runs', async () => {})
evaluate.skip('skipped', async () => { throw new Error('nope') })
