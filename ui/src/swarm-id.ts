/**
 * Swarm ID integration (spike/swarm-id-only).
 *
 * Wraps @snaha/swarm-id 0.4.x: a hidden iframe from the trusted origin holds
 * the account, `connect()` opens the auth popup, and `deriveAppSecret(label)`
 * yields 32 bytes that are the SAME for this account+app+label on every
 * device — the property the MetaMask signature provides in the wallet path.
 * Those bytes seed the regular NookSigner chain (createSeedSigner).
 */
import { SwarmIdClient } from '@snaha/swarm-id'

const IFRAME_ORIGIN = 'https://swarm-id.snaha.net'

/** Domain separator for Nook's identity seed. NEVER change — a different label is a different identity. */
export const NOOK_IDENTITY_LABEL = 'nook-identity-v1'

let client: SwarmIdClient | null = null
let initPromise: Promise<SwarmIdClient> | null = null

const LISTENERS = new Set<() => void>()

/** Subscribe to connection-state changes. Returns an unsubscribe function. */
export function onSwarmIdChange(listener: () => void): () => void {
  LISTENERS.add(listener)

  return () => LISTENERS.delete(listener)
}

/** Lazily create + initialize the client (embeds the hidden proxy iframe once). */
export async function getSwarmId(): Promise<SwarmIdClient> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const c = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      metadata: {
        name: 'Nook',
        description: 'Swarm desktop node manager',
      },
      onConnectionChange: () => LISTENERS.forEach(fn => fn()),
    })

    await c.initialize()
    client = c

    return c
  })()

  return initPromise
}

export interface SwarmIdIdentity {
  id: string
  name: string
  address: string
}

/** The connected Swarm ID identity, or null (not initialized / signed out). */
export function swarmIdIdentity(): SwarmIdIdentity | null {
  try {
    return client?.connectionInfo?.identity ?? null
  } catch {
    return null
  }
}

/**
 * connect() only OPENS the auth page — authentication arrives later through
 * onConnectionChange when the user completes it. Wait for that, bounded.
 */
async function waitForIdentity(timeoutMs = 180_000): Promise<SwarmIdIdentity> {
  const existing = swarmIdIdentity()

  if (existing) return existing

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Sign-in timed out — finish logging in in the Swarm ID window, then try again'))
    }, timeoutMs)
    const unsubscribe = onSwarmIdChange(() => {
      const identity = swarmIdIdentity()

      if (identity) {
        clearTimeout(timer)
        unsubscribe()
        resolve(identity)
      }
    })
  })
}

/**
 * Full sign-in: open the popup if needed, wait for the user to complete it,
 * then derive Nook's identity seed. The seed is deterministic per account —
 * signing in with the same Swarm ID anywhere yields the same Nook identity.
 */
export async function signInWithSwarmId(): Promise<{ seedHex: string; identity: SwarmIdIdentity }> {
  const c = await getSwarmId()

  if (!swarmIdIdentity()) await c.connect()
  const identity = await waitForIdentity()
  const seed = await c.deriveAppSecret(NOOK_IDENTITY_LABEL)
  const seedHex = Array.from(seed)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return { seedHex, identity }
}

export async function signOutOfSwarmId(): Promise<void> {
  if (!client) return
  await client.disconnect()
}
