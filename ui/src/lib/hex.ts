/**
 * Hex <-> bytes conversion, centralized.
 *
 * Previously copy-pasted into 6 files (crypto/signer, components/ShareModal,
 * components/SwarmNotifyTest, pages/Dev, pages/Identity, apps/Messages). The
 * old `hexToBytes` used `clean.match(/.{2}/g)!` — a non-null assertion that
 * threw an opaque TypeError on empty input and silently dropped the trailing
 * nibble on odd-length input. This version validates and throws a clear error
 * instead, while producing byte-identical output for valid input.
 *
 * `bytesToHex` returns lowercase hex WITHOUT a `0x` prefix (unchanged).
 * For validated, length-checked parsing of untrusted hex (share-link params),
 * use `normalizeHex` in notify/share-link.ts instead.
 */

/**
 * Decode a hex string to bytes. Accepts an optional `0x` prefix.
 * @throws if the input is empty, odd-length, or contains non-hex characters.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex

  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Invalid hex string (length ${clean.length}): "${hex.slice(0, 18)}${hex.length > 18 ? '…' : ''}"`)
  }

  const bytes = new Uint8Array(clean.length / 2)

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }

  return bytes
}

/** Encode bytes to lowercase hex (no `0x` prefix). */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
