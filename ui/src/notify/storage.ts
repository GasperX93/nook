import { ContactStore } from '@swarm-notify/sdk'
import type { Contact } from '@swarm-notify/sdk'

/**
 * localStorage-backed persistence for swarm-notify state.
 *
 * Keys:
 *   nook-contacts                          → JSON array of Contact
 *   nook-identity-published:<ethAddress>   → "true" if user has published their identity
 *   nook-onboarding-publish-dismissed      → "true" if user dismissed the publish hint
 *
 * NOTE: per-origin. When #47 (port-independent persistence) lands, swap this
 * implementation but keep the same exported surface so call sites don't change.
 */

const CONTACTS_KEY = 'nook-contacts'
const IDENTITY_PUBLISHED_PREFIX = 'nook-identity-published:'
const ONBOARDING_DISMISSED_KEY = 'nook-onboarding-publish-dismissed'

export function loadContactStore(): ContactStore {
  try {
    const raw = localStorage.getItem(CONTACTS_KEY)

    if (!raw) return new ContactStore()
    const data = JSON.parse(raw) as Contact[]

    return ContactStore.from(data)
  } catch {
    // Corrupt JSON or storage error — start fresh rather than crash
    return new ContactStore()
  }
}

export function saveContactStore(store: ContactStore): void {
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(store.export()))
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
