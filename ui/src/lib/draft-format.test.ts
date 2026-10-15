import { describe, expect, it } from 'vitest'

import { toggleList, toggleWrap } from './draft-format'

describe('toggleWrap', () => {
  it('wraps the selected word and keeps it selected', () => {
    // "say hello now", "hello" selected
    expect(toggleWrap('say hello now', 4, 9, '**')).toEqual({ value: 'say **hello** now', selStart: 6, selEnd: 11 })
    expect(toggleWrap('say hello now', 4, 9, '*')).toEqual({ value: 'say *hello* now', selStart: 5, selEnd: 10 })
    expect(toggleWrap('say hello now', 4, 9, '`')).toEqual({ value: 'say `hello` now', selStart: 5, selEnd: 10 })
  })

  it('with nothing selected, inserts the pair and puts the cursor inside', () => {
    expect(toggleWrap('hi ', 3, 3, '**')).toEqual({ value: 'hi ****', selStart: 5, selEnd: 5 })
  })

  it('takes the marker off again', () => {
    expect(toggleWrap('say **hello** now', 6, 11, '**')).toEqual({ value: 'say hello now', selStart: 4, selEnd: 9 })
    expect(toggleWrap('say *hello* now', 5, 10, '*')).toEqual({ value: 'say hello now', selStart: 4, selEnd: 9 })
    expect(toggleWrap('say `hello` now', 5, 10, '`')).toEqual({ value: 'say hello now', selStart: 4, selEnd: 9 })
  })

  it('adds italic to bold instead of removing a bold star', () => {
    expect(toggleWrap('**hello**', 2, 7, '*')).toEqual({ value: '***hello***', selStart: 3, selEnd: 8 })
  })

  it('removes only its own marker from bold italic', () => {
    expect(toggleWrap('***hello***', 3, 8, '*').value).toBe('**hello**')
    expect(toggleWrap('***hello***', 3, 8, '**').value).toBe('*hello*')
  })
})

describe('toggleList', () => {
  it('starts a list on the current line', () => {
    expect(toggleList('milk', 4, 4)).toEqual({ value: '- milk', selStart: 6, selEnd: 6 })
    expect(toggleList('', 0, 0)).toEqual({ value: '- ', selStart: 2, selEnd: 2 })
  })

  it('makes every selected line an item', () => {
    const text = 'buy:\nmilk\neggs\nthanks'

    // "milk\neggs" selected
    expect(toggleList(text, 5, 14)).toEqual({ value: 'buy:\n- milk\n- eggs\nthanks', selStart: 5, selEnd: 18 })
  })

  it('turns a list back into plain lines', () => {
    expect(toggleList('- milk\n- eggs', 0, 13).value).toBe('milk\neggs')
  })

  it('leaves blank lines inside the selection alone', () => {
    expect(toggleList('a\n\nb', 0, 4).value).toBe('- a\n\n- b')
  })
})
