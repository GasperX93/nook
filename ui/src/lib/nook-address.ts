/**
 * A Nook address as people type or paste it. The app always shows and copies
 * it as `0x` + 40 hex characters, but addresses on Swarm are often written
 * without the prefix — and the identity lookup hashes the string it is given,
 * so a bare address would silently look up a feed that cannot exist.
 *
 * Returns the canonical form (`0x` + lowercase hex), or null when the input
 * is not an address at all.
 */
export function normalizeNookAddress(input: string): string | null {
  const hex = input.trim().replace(/^0x/i, '')

  return /^[0-9a-fA-F]{40}$/.test(hex) ? `0x${hex.toLowerCase()}` : null
}
