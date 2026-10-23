/**
 * Nook's server is for the dashboard on this computer only.
 *
 * The /bee-api proxy hands out the whole Bee API (spend the node's xBZZ on
 * drives, upload onto them, read the wallet), and Bee itself has no auth. So
 * besides listening on loopback only, the proxy refuses what a web page could
 * send: a foreign Origin, a foreign Host (DNS rebinding — a site pointing its
 * own name at 127.0.0.1 is same-origin and sends no Origin), a request the
 * browser marks cross-site, and Swarm content opened as a page on the
 * dashboard's origin (it would read the dashboard's browser data). A local
 * program sends no Origin and is allowed, like Bee and swarm-desktop.
 */
import { RELAY_PORT } from './rpc-endpoints'

/** The dashboard's address — opened as http://localhost:3054 (browser data is per origin). */
export const DASHBOARD_PORT = RELAY_PORT
export const DASHBOARD_ORIGIN = `http://localhost:${DASHBOARD_PORT}`

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'].map(h => `${h}:${DASHBOARD_PORT}`)
const LOCAL_ORIGINS = LOCAL_HOSTS.map(h => `http://${h}`)
const PAGE_DESTINATIONS = ['document', 'iframe', 'frame', 'embed', 'object']

type Headers = Record<string, string | string[] | undefined>

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]

  return Array.isArray(value) ? value[0] : value
}

/** Why a /bee-api request is refused, or null when it may go to Bee. */
export function beeApiRefusal(headers: Headers): string | null {
  const host = (header(headers, 'host') ?? '').toLowerCase()

  if (!LOCAL_HOSTS.includes(host)) return 'not the dashboard address'
  const origin = header(headers, 'origin')

  // "null" (sandboxed frames, some referrer policies) is never the dashboard.
  if (origin !== undefined && !LOCAL_ORIGINS.includes(origin.toLowerCase())) return 'another site'

  if (header(headers, 'sec-fetch-site') === 'cross-site') return 'another site'

  if (PAGE_DESTINATIONS.includes(header(headers, 'sec-fetch-dest') ?? '')) return 'opened as a page'

  return null
}
