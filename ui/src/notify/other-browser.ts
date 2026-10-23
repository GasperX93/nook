/**
 * "This browser doesn't have your drive data yet" (#191/#192 follow-up).
 * Drive data now lives in the app (store/drive-data), but the app learns it
 * from the browser Nook was used in before — until that browser opens this
 * version once, another browser or a private window shows drives with 0
 * files and doesn't know which drives are encrypted.
 *
 * Shown when contacts were restored from the app folder into this browser
 * (so this identity used Nook on this computer before) and the drive data —
 * the app's, which is this browser's copy once loaded — is still empty. It
 * goes away by itself once the drive data arrives. Drive data is node-level,
 * so neither key is namespaced per identity.
 */

const FLAG_KEY = 'nook-other-browser-v1'
const DISMISSED_KEY = 'nook-other-browser-dismissed-v1'

export const OTHER_BROWSER_EVENT = 'nook:other-browser'

function count(key: string): number {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')

    if (Array.isArray(value)) return value.length

    return value && typeof value === 'object' ? Object.keys(value).length : 0
  } catch {
    return 0
  }
}

/** Any file, encrypted-drive setting or shared drive known here (the app's data once loaded). */
export function hasDriveData(): boolean {
  return count('swarm-drive') + count('nook-drive-metadata') + count('nook-shared-drives') > 0
}

/** Call after contacts were restored into this browser from the app folder. */
export function noteContactsRestored(): void {
  try {
    if (localStorage.getItem(FLAG_KEY) !== null || hasDriveData()) return
    localStorage.setItem(FLAG_KEY, String(Date.now()))
  } catch {
    return
  }
  window.dispatchEvent(new Event(OTHER_BROWSER_EVENT))
}

export function showOtherBrowserNotice(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) !== null && localStorage.getItem(DISMISSED_KEY) === null && !hasDriveData()
  } catch {
    return false
  }
}

export function dismissOtherBrowserNotice(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // storage unavailable — it shows again next time
  }
  window.dispatchEvent(new Event(OTHER_BROWSER_EVENT))
}
