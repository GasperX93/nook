import { describe, expect, it } from 'vitest'

import { rowStatusLabel } from './transfer-labels'

describe('rowStatusLabel', () => {
  it('says Paused / Resuming instead of the last percentage', () => {
    expect(rowStatusLabel('node', 100, 'Copying')).toBe('Paused')
    expect(rowStatusLabel('resuming', 40, 'Storing')).toBe('Resuming…')
  })

  it('shows the verb with progress while pieces move', () => {
    expect(rowStatusLabel(undefined, 14, 'Storing')).toBe('Storing 14%')
    expect(rowStatusLabel(undefined, null, 'Updating')).toBe('Updating…')
  })
})
