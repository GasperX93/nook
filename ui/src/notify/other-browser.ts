/**
 * "This browser doesn't have your drive data" (#191/#192 follow-up). Contacts
 * and messages come back in another browser or a private window, but file
 * lists, folders, encrypted-drive settings and Shared with me are still kept
 * only in the browser Nook was used in. Without a word, drives show "0 files"
 * there.
 *
 * Detected when contacts were restored from the app folder into this browser
 * (so this identity used Nook on this computer before, elsewhere) and this
 * browser has never stored any drive data. A browser that has its own
 * contacts, or a new install, never sees it. Drive data is node-level, so
 * neither key is namespaced per identity.
 */

const FLAG_KEY = 'nook-other-browser-v1'
const DISMISSED_KEY = 'nook-other-browser-dismissed-v1'
const DRIVE_KEYS = ['swarm-drive', 'nook-drive-metadata', 'nook-shared-drives']

export const OTHER_BROWSER_EVENT = 'nook:other-browser'

/** Call after contacts were restored into this browser from the app folder. */
export function noteContactsRestored(): void {
  try {
    if (localStorage.getItem(FLAG_KEY) !== null) return

    if (!DRIVE_KEYS.every(key => localStorage.getItem(key) === null)) return
    localStorage.setItem(FLAG_KEY, String(Date.now()))
  } catch {
    return
  }
  window.dispatchEvent(new Event(OTHER_BROWSER_EVENT))
}

export function showOtherBrowserNotice(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) !== null && localStorage.getItem(DISMISSED_KEY) === null
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
