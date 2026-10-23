/**
 * "Contact data changed" signal for the app-folder backup (#192). The storage
 * modules call it after a write; contact-backup.ts listens. A separate module
 * so storage doesn't import the backup (which imports storage).
 */

let listener: (() => void) | null = null

export function onContactDataChanged(fn: (() => void) | null): void {
  listener = fn
}

export function contactDataChanged(): void {
  listener?.()
}

/**
 * Fired once the saved contacts were merged in, so the inbox poller reads
 * them right away — before the user can send in a restored thread, which
 * would stop its older sent messages from being loaded (#191).
 */
export const CONTACTS_RESTORED_EVENT = 'nook:contacts-restored'
