jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/contact-backup-spec',
    config: 'test/data/contact-backup-spec',
    cache: 'test/data/contact-backup-spec',
    log: 'test/data/contact-backup-spec',
    temp: 'test/data/contact-backup-spec',
  })),
)

import { rmSync } from 'fs'

import { isBackupAddress, readContactBackup, writeContactBackup } from '../src/contact-backup'

// Contacts in the app folder (#192): one file per identity, only a valid shape is stored.

const ME = '0x' + 'a'.repeat(40)

afterAll(() => rmSync('test/data/contact-backup-spec', { recursive: true, force: true }))

test('only a lowercase 0x address names a file', () => {
  expect(isBackupAddress(ME)).toBe(true)
  expect(isBackupAddress('../../etc/passwd')).toBe(false)
  expect(isBackupAddress('0x' + 'A'.repeat(40))).toBe(false)
})

test('nothing saved yet → null; saved → read back', () => {
  expect(readContactBackup(ME)).toBeNull()
  expect(writeContactBackup(ME, { contacts: [{ id: 'x' }], sendCursors: { x: 2 }, myName: 'Gasper' })).toBe(true)
  expect(readContactBackup(ME)).toEqual({
    contacts: [{ id: 'x' }],
    sendCursors: { x: 2 },
    readMarks: {},
    theirNext: {},
    myName: 'Gasper',
  })
})

test('a wrong shape is refused and the saved copy stays', () => {
  expect(writeContactBackup(ME, { contacts: 'nope' })).toBe(false)
  expect(writeContactBackup(ME, null)).toBe(false)
  expect(readContactBackup(ME)?.myName).toBe('Gasper')
})
