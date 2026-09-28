import { readFileSync } from 'fs'
import net from 'net'
import { join } from 'path'
import { fetchWithTimeout } from './fetch-timeout'
import { logger } from './logger'
import { getPath } from './path'

/**
 * Another Bee already on Nook's ports (R5-11, Option A — user decision
 * 2026-09-23; research: spindle notes/existing-bee-conflict-2026-09-23.md).
 *
 * Nook runs its Bee on the standard ports (API 127.0.0.1:1633, p2p :1634),
 * the same a standalone `bee`, Docker Bee or Swarm Desktop uses, and Bee's
 * API is not restricted — so a foreign node there answers every Nook call.
 * Without this check Nook's launch crash-looped on the taken ports while its
 * monitors happily talked to the OTHER node — and could buy storage or
 * deposit into a chequebook with that node's funds.
 *
 * Identity: Nook's own node key (data-dir/keys/swarm.key, a V3 keystore) has
 * its address in the clear — no password needed — and Bee reports its own in
 * GET /addresses (`ethereum`). Same address = Nook's own node (e.g. left over
 * after a Nook crash) → use it; anything else = foreign → don't launch, don't
 * talk to it, tell the user.
 */

export const BEE_API_PORT = 1633
export const BEE_P2P_PORT = 1634

export type BeePortState =
  | { kind: 'free' }
  | { kind: 'own' }
  | { kind: 'foreign'; port: number; address: string | null }

/** What the dashboard shows while a foreign node blocks Nook's (via /status). */
export interface ForeignBee {
  port: number
  /** The other node's Ethereum address, when it answered /addresses. */
  address: string | null
  since: number
}

let foreign: ForeignBee | null = null

export function getForeignBee(): ForeignBee | null {
  return foreign ? { ...foreign } : null
}

function normalize(address: unknown): string | null {
  return typeof address === 'string' && address ? address.toLowerCase().replace(/^0x/, '') : null
}

/** Nook's own node address from the keystore (readable without the password). */
export function ownBeeAddress(): string | null {
  try {
    const v3 = JSON.parse(readFileSync(getPath(join('data-dir', 'keys', 'swarm.key')), 'utf-8'))

    return normalize(v3.address)
  } catch {
    return null
  }
}

/** Whether something accepts TCP connections on a local port. */
export async function portOpen(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }

    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** The Ethereum address of whatever Bee answers on the API port, if any. */
export async function addressOnApiPort(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${BEE_API_PORT}/addresses`, {}, 3_000)

    if (!res.ok) return null

    return normalize(((await res.json()) as { ethereum?: string }).ethereum)
  } catch {
    return null
  }
}

const sleep = async (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * Who holds Nook's Bee ports right now. A node that is still starting may
 * hold a port before its API answers, so an unidentified answer is re-checked
 * a few times before being called foreign. Exported probes are injectable for
 * tests.
 */
export async function checkBeePorts(
  probes = { portOpen, addressOnApiPort, ownBeeAddress, sleep },
): Promise<BeePortState> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [api, p2p] = await Promise.all([probes.portOpen(BEE_API_PORT), probes.portOpen(BEE_P2P_PORT)])

    if (!api && !p2p) return { kind: 'free' }

    if (api) {
      const [address, own] = [await probes.addressOnApiPort(), probes.ownBeeAddress()]

      if (address && own && address === own) return { kind: 'own' }

      // A different, identified node — no point waiting.
      if (address) return { kind: 'foreign', port: BEE_API_PORT, address: `0x${address}` }
    }

    if (attempt < 2) await probes.sleep(2_000)
  }

  const apiTaken = await probes.portOpen(BEE_API_PORT)

  return { kind: 'foreign', port: apiTaken ? BEE_API_PORT : BEE_P2P_PORT, address: null }
}

/**
 * Run before every Bee launch. Returns true when Nook may start its own Bee.
 * Logs only on state changes — the keep-alive loop calls this every 10 s
 * while a foreign node blocks the ports.
 */
export async function mayLaunchBee(): Promise<boolean> {
  const state = await checkBeePorts()

  if (state.kind === 'foreign') {
    if (!foreign || foreign.port !== state.port || foreign.address !== state.address) {
      logger.error(
        `Another Bee node is using port ${state.port}${state.address ? ` (node ${state.address})` : ''} — ` +
          'Nook will not start its own node or use that one until it stops',
      )
      foreign = { port: state.port, address: state.address, since: Date.now() }
    }
    // A cached "own" from before the other node appeared must not let a
    // monitor spend for up to a minute (isOwnBee).
    ownCheck = { at: 0, ok: false }

    return false
  }

  if (foreign) logger.info('The other Bee node is gone — starting Nook’s own node')
  foreign = null

  if (state.kind === 'own') {
    if (!adoptedLogged) logger.info('Nook’s own Bee node is already running (left from an earlier session) — using it')
    adoptedLogged = true

    return false
  }
  adoptedLogged = false

  return true
}

let adoptedLogged = false

// ── Spending guard ──────────────────────────────────────────────────────────

let ownCheck = { at: 0, ok: false }

/**
 * True only when the node on the API port is provably Nook's own. Every
 * automatic spend (reserve purchase, chequebook deposit, auto-renew) checks
 * this first, so a foreign node's funds are never touched. Cached for a
 * minute — the monitors run far less often than that.
 */
export async function isOwnBee(now = Date.now()): Promise<boolean> {
  if (now - ownCheck.at < 60_000) return ownCheck.ok

  const [address, own] = [await addressOnApiPort(), ownBeeAddress()]

  ownCheck = { at: now, ok: Boolean(address && own && address === own) }

  return ownCheck.ok
}
