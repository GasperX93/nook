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
