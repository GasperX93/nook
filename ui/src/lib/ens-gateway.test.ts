import { describe, expect, it } from 'vitest'

import { bzzLink, limoHost } from './ens-gateway'

describe('ENS gateway links', () => {
  it('drops .eth for a simple name on bzz.link (one label before bzz.link)', () => {
    expect(bzzLink('mzupan.eth')).toEqual({ url: 'https://mzupan.bzz.link/', label: 'mzupan.bzz.link' })
  })

  it('uses the secure path form for subnames (the certificate covers one label only)', () => {
    expect(bzzLink('martin.zupan.eth')).toEqual({
      url: 'https://bzz.link/bzz/martin.zupan.eth/',
      label: 'bzz.link/bzz/martin.zupan.eth',
    })
  })

  it('has no bzz.link link for non-.eth names', () => {
    expect(bzzLink('example.com')).toBeNull()
  })

  it('keeps the full name for eth.limo', () => {
    expect(limoHost('blog.mzupan.eth')).toBe('blog.mzupan.eth.limo')
  })
})
