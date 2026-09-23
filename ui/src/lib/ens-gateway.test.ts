import { describe, expect, it } from 'vitest'

import { bzzLinkHost, limoHost } from './ens-gateway'

describe('ENS gateway hosts', () => {
  it('drops .eth for bzz.link (one label before bzz.link)', () => {
    expect(bzzLinkHost('mzupan.eth')).toBe('mzupan.bzz.link')
  })

  it('has no bzz.link address for subnames or non-.eth names', () => {
    expect(bzzLinkHost('blog.mzupan.eth')).toBeNull()
    expect(bzzLinkHost('example.com')).toBeNull()
  })

  it('keeps the full name for eth.limo', () => {
    expect(limoHost('blog.mzupan.eth')).toBe('blog.mzupan.eth.limo')
  })
})
