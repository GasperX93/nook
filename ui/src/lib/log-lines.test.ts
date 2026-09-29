import { describe, expect, it } from 'vitest'

import { isProblem, parseLog, parseLogLine } from './log-lines'

describe('parseLogLine', () => {
  it('parses a Nook (winston) line', () => {
    const l = parseLogLine(
      'time="2026-09-23T10:39:22.249Z" level="info" msg="Depositing 20000000000000000 PLUR into chequebook"',
    )

    expect(l).toMatchObject({
      time: '10:39:22',
      level: 'info',
      msg: 'Depositing 20000000000000000 PLUR into chequebook',
    })
    expect(l.isAccess).toBe(false)
  })

  it('flags Nook access-log lines and keeps their details', () => {
    const l = parseLogLine(
      'time="2026-09-23T10:29:28.762Z" level="info" msg="api access" method="GET" status=200 uri="/status"',
    )

    expect(l.isAccess).toBe(true)
    expect(l.details).toContain('uri=/status')
  })

  it('parses a Bee line with its logger', () => {
    const l = parseLogLine(
      '"time"="2026-09-23 13:34:51.255601" "level"="error" "logger"="node/api/get_wallet" "msg"="unable to acquire balance from the chain backend"',
    )

    expect(l).toMatchObject({ time: '13:34:51', level: 'error', logger: 'node/api/get_wallet' })
    expect(isProblem(l)).toBe(true)
  })

  it('keeps unparseable text as a raw line', () => {
    const l = parseLogLine('    at Module._compile (node:internal)')

    expect(l.level).toBe('other')
    expect(l.msg).toBeUndefined()
    expect(l.raw).toBe('    at Module._compile (node:internal)')
  })
})

describe('parseLog', () => {
  it('keeps only the last N non-empty lines', () => {
    const text = ['level="info" msg="a"', '', 'level="warn" msg="b"', 'level="error" msg="c"'].join('\n')

    expect(parseLog(text, 2).map(l => l.msg)).toEqual(['b', 'c'])
  })
})
