import { describe, expect, it } from 'vitest'

import { parseInline, parseMessage } from './message-format'

describe('parseInline', () => {
  it('leaves plain text alone', () => {
    expect(parseInline('hello there')).toEqual([{ t: 'text', v: 'hello there' }])
  })

  it('reads bold, italic and code', () => {
    expect(parseInline('a **b** *c* `d`')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'bold', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'italic', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'd' },
    ])
  })

  it('allows italic inside bold', () => {
    expect(parseInline('**very *much* so**')).toEqual([
      {
        t: 'bold',
        c: [
          { t: 'text', v: 'very ' },
          { t: 'italic', c: [{ t: 'text', v: 'much' }] },
          { t: 'text', v: ' so' },
        ],
      },
    ])
  })

  it('does not format inside code', () => {
    expect(parseInline('`**x**`')).toEqual([{ t: 'code', v: '**x**' }])
  })

  it('treats stars between words and numbers as text', () => {
    expect(parseInline('2*3*4')).toEqual([{ t: 'text', v: '2*3*4' }])
    expect(parseInline('a * b * c')).toEqual([{ t: 'text', v: 'a * b * c' }])
  })

  it('keeps an unclosed marker as typed', () => {
    expect(parseInline('**not closed')).toEqual([{ t: 'text', v: '**not closed' }])
    expect(parseInline('a `b')).toEqual([{ t: 'text', v: 'a `b' }])
  })

  it('links web addresses and leaves the sentence punctuation out', () => {
    expect(parseInline('see https://nook-drive.eth.limo/how-it-works.html.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://nook-drive.eth.limo/how-it-works.html' },
      { t: 'text', v: '.' },
    ])
    expect(parseInline('(https://example.org/a)')).toEqual([
      { t: 'text', v: '(' },
      { t: 'link', href: 'https://example.org/a' },
      { t: 'text', v: ')' },
    ])
    expect(parseInline('https://en.wikipedia.org/wiki/Swarm_(app)')).toEqual([
      { t: 'link', href: 'https://en.wikipedia.org/wiki/Swarm_(app)' },
    ])
  })

  it('never links anything but http and https', () => {
    const script = ['java', 'script:alert(1)'].join('')

    for (const s of [script, 'data:text/html,x', 'file:///etc/passwd', 'nook://contact/v1?addr=0x1']) {
      expect(parseInline(s).some(t => t.t === 'link')).toBe(false)
    }
  })
})

describe('parseMessage', () => {
  it('keeps a plain message as one paragraph with its line breaks', () => {
    expect(parseMessage('line one\nline two')).toEqual([{ t: 'p', c: [{ t: 'text', v: 'line one\nline two' }] }])
  })

  it('splits paragraphs on blank lines', () => {
    expect(parseMessage('a\n\nb')).toHaveLength(2)
  })

  it('reads a bullet list', () => {
    expect(parseMessage('todo:\n- one\n- **two**')).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'todo:' }] },
      { t: 'list', items: [[{ t: 'text', v: 'one' }], [{ t: 'bold', c: [{ t: 'text', v: 'two' }] }]] },
    ])
  })

  it('reads a fenced code block without formatting it', () => {
    expect(parseMessage('run:\n```\nnpm **start**\n- x\n```\ndone')).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'run:' }] },
      { t: 'code', v: 'npm **start**\n- x' },
      { t: 'p', c: [{ t: 'text', v: 'done' }] },
    ])
  })

  it('treats an unclosed fence as text', () => {
    expect(parseMessage('```\nhalf')).toEqual([{ t: 'p', c: [{ t: 'text', v: '```\nhalf' }] }])
  })

  it('returns nothing for an empty message', () => {
    expect(parseMessage('')).toEqual([])
  })
})
