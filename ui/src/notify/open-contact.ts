/**
 * The conversation open on screen, so the inbox poller reads it first (#191):
 * in a new browser the first poll reads every contact's history from the
 * start, and the one you're looking at shouldn't wait for the others.
 */

export const OPEN_CONTACT_EVENT = 'nook:open-contact'

let openContact: string | null = null

export function getOpenContact(): string | null {
  return openContact
}

/** Set when a conversation opens (null when it closes); a newly opened one is read right away. */
export function setOpenContact(id: string | null): void {
  const next = id?.toLowerCase() ?? null

  if (next === openContact) return
  openContact = next

  if (next) window.dispatchEvent(new Event(OPEN_CONTACT_EVENT))
}
