/**
 * "Make me findable" consent (#130/#131) — collected during onboarding's
 * identity card, honored by useAutoPublish once the reserved space exists.
 * Defaults to ON (pre-ticked): being findable is the point of an identity,
 * and the checkbox is the explicit opt-out.
 */

const KEY = 'nook:auto-publish-consent'

export function getPublishConsent(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function setPublishConsent(value: boolean): void {
  try {
    localStorage.setItem(KEY, value ? '1' : '0')
  } catch {
    // private mode — consent stays default-on in memory
  }
}
