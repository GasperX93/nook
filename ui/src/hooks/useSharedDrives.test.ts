// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseShareLink } from './useSharedDrives'

describe('parseShareLink', () => {
  // ─── Feed-based links ─────────────────────────────────────────────────

  describe('feed-based', () => {
    it('parses valid feed link', () => {
      const result = parseShareLink('swarm://feed?topic=abc123&owner=def456&publisher=ghi789')
      expect(result).toEqual({
        type: 'feed',
        feedTopic: 'abc123',
        feedOwner: 'def456',
        actPublisher: 'ghi789',
      })
    })

    it('returns null when topic is missing', () => {
      expect(parseShareLink('swarm://feed?owner=def&publisher=ghi')).toBeNull()
    })

    it('returns null when owner is missing', () => {
      expect(parseShareLink('swarm://feed?topic=abc&publisher=ghi')).toBeNull()
    })

    it('returns null when publisher is missing', () => {
      expect(parseShareLink('swarm://feed?topic=abc&owner=def')).toBeNull()
    })
  })

  // ─── Snapshot links ───────────────────────────────────────────────────

  describe('snapshot', () => {
    const ref = 'a'.repeat(64)

    it('parses valid snapshot link', () => {
      const result = parseShareLink(`swarm://${ref}?publisher=pub&history=hist`)
      expect(result).toEqual({
        type: 'snapshot',
        reference: ref,
        actPublisher: 'pub',
        actHistoryRef: 'hist',
      })
    })

    it('returns null when reference is too short', () => {
      expect(parseShareLink('swarm://short?publisher=pub&history=hist')).toBeNull()
    })

    it('returns null when history is missing', () => {
      expect(parseShareLink(`swarm://${ref}?publisher=pub`)).toBeNull()
    })
  })

  // ─── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseShareLink('')).toBeNull()
    })

    it('returns null for string with no query params', () => {
      expect(parseShareLink('swarm://feed')).toBeNull()
    })

    it('returns null for non-swarm URLs', () => {
      expect(parseShareLink('http://example.com?publisher=x')).toBeNull()
    })

    it('handles URL-decoded links from deep link roundtrip', () => {
      const original = 'swarm://feed?topic=abc&owner=def&publisher=ghi'
      const encoded = encodeURIComponent(original)
      const decoded = decodeURIComponent(encoded)
      const result = parseShareLink(decoded)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('feed')
      expect(result!.feedTopic).toBe('abc')
    })
  })
})
