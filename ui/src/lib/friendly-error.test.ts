import { describe, expect, it } from 'vitest'

import { friendlyError } from './friendly-error'

describe('friendlyError', () => {
  it('explains a native engine load failure instead of dumping it', () => {
    const dump =
      'dlopen(/Applications/Nook.app/.../better_sqlite3.node, 0x0001): code signature ... different Team IDs\n    at Module._extensions..node'

    expect(friendlyError(new Error(dump), 'x')).toMatch(/^Deletable drives couldn't start/)
  })

  it('keeps only the first line of other errors, capped', () => {
    expect(friendlyError(new Error('Drive expired\n  at stack'), 'x')).toBe('Drive expired')
    expect(friendlyError(new Error('a'.repeat(300)), 'x')).toHaveLength(161)
  })

  it('falls back when there is no message', () => {
    expect(friendlyError(new Error(''), 'Upload failed')).toBe('Upload failed')
    expect(friendlyError(undefined, 'Upload failed')).toBe('Upload failed')
  })
})
