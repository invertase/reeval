import { fakeHarness } from 'reeval/harness'

export const writer = fakeHarness({ id: 'writer', files: { 'out.txt': 'hi\n' } })
export const copier = fakeHarness({ id: 'copier', files: { 'out.txt': 'hi\n' } })
export const idler = fakeHarness({ id: 'idler' })
