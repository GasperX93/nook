/**
 * Swarm ID POC integration.
 * Temporary file for testing Swarm ID SDK in Nook.
 * Safe to delete — no other code depends on this.
 */
import { SwarmIdClient } from '@snaha/swarm-id'

let client: SwarmIdClient | null = null
let authStatus = false

const AUTH_LISTENERS = new Set<(authenticated: boolean) => void>()

export function getSwarmIdClient(): SwarmIdClient | null {
  return client
}

export function isSwarmIdAuthenticated(): boolean {
  return authStatus
}

export function onSwarmIdAuthChange(listener: (authenticated: boolean) => void): () => void {
  AUTH_LISTENERS.add(listener)

  return () => AUTH_LISTENERS.delete(listener)
}

export async function initSwarmId(): Promise<SwarmIdClient> {
  if (client) return client

  client = new SwarmIdClient({
    iframeOrigin: 'https://swarm-id.snaha.net',
    metadata: {
      name: 'Nook',
      description: 'Swarm desktop node manager',
    },
    onAuthChange: (authenticated: boolean) => {
      authStatus = authenticated
      AUTH_LISTENERS.forEach(fn => fn(authenticated))
    },
    timeout: 30000,
  })

  await client.initialize()
  const status = await client.checkAuthStatus()
  authStatus = status.authenticated

  return client
}

export async function connectSwarmId(): Promise<void> {
  const c = await initSwarmId()
  await c.connect()
}

export async function disconnectSwarmId(): Promise<void> {
  if (!client) return
  await client.disconnect()
}

export function destroySwarmId(): void {
  if (!client) return
  client.destroy()
  client = null
  authStatus = false
}
