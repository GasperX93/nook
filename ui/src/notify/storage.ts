import type { NookContact } from './types'

/**
 * localStorage-backed persistence for swarm-notify state.
 *
 * Keys:
 *   nook-contacts-v2                       → JSON array of NookContact
 *   nook-identity-published:<ethAddress>   → "true" if user has published their identity
 *   nook-onboarding-publish-dismissed      → "true" if user dismissed the publish hint
 *
 * NOTE: per-origin. When #47 (port-independent persistence) lands, swap this
 * implementation but keep the same exported surface so call sites don't change.
 *
 * v2 schema is a clean break from the original (overlay-bearing) v1. We never
 * shipped v1 to users so no migration needed.
 */

const CONTACTS_KEY = 'nook-contacts-v2'
const IDENTITY_PUBLISHED_PREFIX = 'nook-identity-published:'
const ONBOARDING_DISMISSED_KEY = 'nook-onboarding-publish-dismissed'

export function loadContacts(): NookContact[] {
  try {
    const raw = localStorage.getItem(CONTACTS_KEY)

    if (!raw) return []
    const data = JSON.parse(raw) as NookContact[]

    return Array.isArray(data) ? data : []
  } catch {
    // Corrupt JSON or storage error — start fresh rather than crash
    return []
  }
}

export function saveContacts(contacts: NookContact[]): void {
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts))
}

/** Add a contact. Throws if a contact with the same id already exists. */
export function addContact(contacts: NookContact[], next: NookContact): NookContact[] {
  const id = next.id.toLowerCase()
  const exists = contacts.some(c => c.id.toLowerCase() === id)

  if (exists) {
    throw new Error(`Contact already exists: ${id}`)
  }
  const updated = [...contacts, { ...next, id }]

  saveContacts(updated)

  return updated
}

/** Remove a contact by id (case-insensitive). */
export function removeContact(contacts: NookContact[], id: string): NookContact[] {
  const updated = contacts.filter(c => c.id.toLowerCase() !== id.toLowerCase())

  saveContacts(updated)

  return updated
}

export function isIdentityPublished(ethAddress: string): boolean {
  return localStorage.getItem(IDENTITY_PUBLISHED_PREFIX + ethAddress.toLowerCase()) === 'true'
}

export function markIdentityPublished(ethAddress: string): void {
  localStorage.setItem(IDENTITY_PUBLISHED_PREFIX + ethAddress.toLowerCase(), 'true')
}

export function clearIdentityPublished(ethAddress: string): void {
  localStorage.removeItem(IDENTITY_PUBLISHED_PREFIX + ethAddress.toLowerCase())
}

export function isOnboardingDismissed(): boolean {
  return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true'
}

export function markOnboardingDismissed(): void {
  localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true')
}
