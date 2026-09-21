/**
 * "Keep me findable" consent (#130/#131) — honored by useAutoPublish once
 * the reserved space exists. Defaults to ON: being findable is the point of
 * an identity; onboarding says so in a sentence, and the explicit opt-out
 * toggle lives on Account → Identity (post-test feedback: no checkbox at
 * creation time).
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
