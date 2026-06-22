import { shell } from 'electron'
import { getApiKey } from './api-key'
import { port } from './port'

export function openDashboardInBrowser() {
  shell.openExternal(`http://localhost:${port.value}/dashboard/?v=${getApiKey()}`)
}

/**
 * Open the dashboard with a `?contact=` query param so the renderer's Contacts
 * page can pre-fill the share-link import form.
 */
export function openDashboardWithContact(nookUrl: string) {
  const encoded = encodeURIComponent(nookUrl)

  shell.openExternal(`http://localhost:${port.value}/dashboard/?v=${getApiKey()}&contact=${encoded}#/contacts`)
}
