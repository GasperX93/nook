/**
 * Swarm ID integration.
 *
 * Wraps @snaha/swarm-id 0.4.x: a hidden iframe from the trusted origin holds
 * the account, `connect()` opens the auth popup, and `deriveAppSecret(label)`
 * yields 32 bytes that are the SAME for this account+app+label on every
 * device — the property the MetaMask signature provides in the wallet path.
 * Those bytes seed the regular NookSigner chain (createSeedSigner).
 */
import { SwarmIdClient } from '@snaha/swarm-id'

const IFRAME_ORIGIN = 'https://swarm-id.snaha.net'

/**
 * DOM host for the SDK's iframe + its "Login with Swarm ID" button. Without a
 * containerId the SDK pins a floating widget bottom-right; with it, the button
 * renders where we put the div — inside SwarmIdDialog. The container must stay
 * MOUNTED for the app's lifetime (remounting loses the popup's receiver), and
 * the connect click must happen on the SDK's own button: a popup opened from
 * inside the iframe keeps the iframe as window.opener, which is what makes
 * session handover work under partitioned storage (Brave, Safari ITP).
 * Pattern from the apiritivo reference integration.
 */
export const SWARM_ID_FRAME_CONTAINER_ID = 'swarm-id-frame'

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
    // The button renders inside the SDK iframe, so CSS variables can't reach
    // it — read the active theme once at init and pass concrete colors
    // matching Nook's primary button (dark-on-light / light-on-dark).
    const dark = document.documentElement.classList.contains('dark')

    const c = new SwarmIdClient({
      iframeOrigin: IFRAME_ORIGIN,
      containerId: SWARM_ID_FRAME_CONTAINER_ID,
      // A sized popup, not a full tab (the default 'window' mode).
      popupMode: 'popup',
      metadata: {
        name: 'Nook',
        description: 'Swarm desktop node manager',
      },
      buttonConfig: {
        connectText: 'Sign in with Swarm ID',
        loadingText: 'Signing in…',
        backgroundColor: dark ? '#fafafa' : '#171717',
        color: dark ? '#171717' : '#fafafa',
        borderRadius: '8px',
      },
      onConnectionChange: () => LISTENERS.forEach(fn => fn()),
    })

    await c.initialize()
    client = c

    return c
  })()

  return initPromise
}

let signInDialogOpen = false
const DIALOG_LISTENERS = new Set<(open: boolean) => void>()

export function isSignInDialogOpen(): boolean {
  return signInDialogOpen
}

export function onSignInDialog(listener: (open: boolean) => void): () => void {
  DIALOG_LISTENERS.add(listener)

  return () => DIALOG_LISTENERS.delete(listener)
}

export function setSignInDialogOpen(open: boolean): void {
  signInDialogOpen = open
  DIALOG_LISTENERS.forEach(fn => fn(open))
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
 * The connect click happens on the SDK's button inside the dialog (see
 * SWARM_ID_FRAME_CONTAINER_ID) — authentication then arrives through
 * onConnectionChange. Wait for identity, dialog dismissal, or timeout.
 */
async function waitForIdentity(timeoutMs = 180_000): Promise<SwarmIdIdentity> {
  const existing = swarmIdIdentity()

  if (existing) return existing

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribeId()
      unsubscribeDialog()
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Sign-in timed out — finish logging in in the Swarm ID window, then try again')))
    }, timeoutMs)
    const unsubscribeId = onSwarmIdChange(() => {
      const identity = swarmIdIdentity()

      if (identity) finish(() => resolve(identity))
    })
    const unsubscribeDialog = onSignInDialog(open => {
      if (!open) finish(() => reject(new Error('Sign-in cancelled')))
    })
  })
}

/**
 * Full sign-in: reveal the dialog holding the SDK's button, wait for the user
 * to complete the flow, then derive Nook's identity seed. The seed is
 * deterministic per account — signing in with the same Swarm ID anywhere
 * yields the same Nook identity.
 */
export async function signInWithSwarmId(): Promise<{ seedHex: string; identity: SwarmIdIdentity }> {
  const c = await getSwarmId()
  let identity = swarmIdIdentity()

  if (!identity) {
    setSignInDialogOpen(true)
    try {
      identity = await waitForIdentity()
    } finally {
      setSignInDialogOpen(false)
    }
  }
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
