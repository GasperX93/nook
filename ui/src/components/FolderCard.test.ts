import { describe, expect, it } from 'vitest'

import { folderCountLabel } from './FolderCard'

describe('folderCountLabel', () => {
  it('writes the count out, singular and plural', () => {
    expect(folderCountLabel(0)).toBe('0 files')
    expect(folderCountLabel(1)).toBe('1 file')
    expect(folderCountLabel(3, 1)).toBe('3 files · 1 folder')
    expect(folderCountLabel(1, 2)).toBe('1 file · 2 folders')
  })
})
