jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data',
    config: 'test/data',
    cache: 'test/data',
    log: 'test/data',
    temp: 'test/data',
  })),
)
jest.mock('../src/notify', () => ({ createNotification: jest.fn() }))

import { rmSync } from 'fs'

import { createNotification } from '../src/notify'
import { loadNotifications, markNotificationsRead, pushNotification } from '../src/notifications'

// The bell's contract (#138): events are permanent (up to the cap), newest
// first, desktop firing is explicit per event, and reads are idempotent.

const STORE = 'test/data/notifications.json'

function cleanUp() {
  rmSync(STORE, { force: true })
  ;(createNotification as jest.Mock).mockClear()
}

beforeEach(cleanUp)
afterAll(cleanUp)

describe('notification store', () => {
  it('push → load roundtrip, newest first', () => {
    pushNotification({ type: 'info', title: 'first', body: 'a' })
    pushNotification({ type: 'info', title: 'second', body: 'b' })

    const all = loadNotifications()

    expect(all.map(n => n.title)).toEqual(['second', 'first'])
    expect(all[0].readAt).toBeUndefined()
  })

  it('rejects unknown types', () => {
    expect(() => pushNotification({ type: 'evil' as never, title: 'x', body: 'y' })).toThrow(/Unknown/)
  })

  it('caps history at 50, dropping the oldest', () => {
    for (let i = 0; i < 55; i++) pushNotification({ type: 'info', title: `n${i}`, body: '' })
    const all = loadNotifications()

    expect(all).toHaveLength(50)
    expect(all[0].title).toBe('n54')
    expect(all[49].title).toBe('n5')
  })

  it('desktop fires only when asked', () => {
    pushNotification({ type: 'info', title: 'silent', body: '' })
    expect(createNotification).not.toHaveBeenCalled()

    pushNotification({ type: 'charge-executed', title: 'loud', body: 'paid', desktop: true })
    expect(createNotification).toHaveBeenCalledTimes(1)
  })

  it('markNotificationsRead: specific ids, then all; idempotent', () => {
    const a = pushNotification({ type: 'info', title: 'a', body: '' })

    pushNotification({ type: 'info', title: 'b', body: '' })

    expect(markNotificationsRead([a.id])).toBe(1)
    expect(loadNotifications().find(n => n.id === a.id)?.readAt).toBeDefined()

    expect(markNotificationsRead()).toBe(1) // only 'b' was left unread
    expect(markNotificationsRead()).toBe(0)
  })

  it('keeps structured data for ledger consumers (#139)', () => {
    pushNotification({
      type: 'charge-executed',
      title: 'Extended "Photos"',
      body: '0.65 xBZZ',
      data: { batchId: 'ab'.repeat(32), months: 1, amountXbzz: '0.65' },
    })
    expect(loadNotifications()[0].data).toMatchObject({ months: 1, amountXbzz: '0.65' })
  })
})
