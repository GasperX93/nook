import { logger } from './logger'

/**
 * Bee process supervision policy (#94): restart backoff, crash-loop detection,
 * and the sleep/wake liveness check. Pure state machine — the keep-alive loop
 * in launcher.ts drives it and injects probes, so this stays unit-testable.
 *
 * Backoff: a run that dies within FAST_CRASH_MS counts as a fast crash;
 * consecutive fast crashes double the restart delay (10s → 20s → 40s → … 5min
 * cap). After MAX_FAST_CRASHES the supervisor stops restarting entirely and
 * flags `crashLoop` (surfaced on /status → UI banner) until the user retries.
 *
 * Liveness: a node that reports 0 peers for ZERO_PEERS_LIMIT_MS while the host
 * has internet is wedged (classic laptop sleep/wake) — kill it so the
 * keep-alive relaunches with fresh p2p state. Wedge restarts don't climb the
 * crash ladder: the run's uptime exceeds FAST_CRASH_MS, so the crash counter
 * resets on exit.
 */

const BASE_RESTART_DELAY_MS = 10_000
const MAX_RESTART_DELAY_MS = 5 * 60_000
/** A run shorter than this counts as a fast crash. */
const FAST_CRASH_MS = 60_000
/** Consecutive fast crashes before giving up (crash loop). */
const MAX_FAST_CRASHES = 5
/** Don't evaluate liveness until the node has had time to bootstrap. */
const LIVENESS_GRACE_MS = 5 * 60_000
/** 0 peers for this long (with internet up) ⇒ wedged. */
const ZERO_PEERS_LIMIT_MS = 5 * 60_000

interface SupervisorState {
  consecutiveFastCrashes: number
  notBeforeMs: number
  crashLoop: boolean
  lastStartMs: number | null
  zeroPeersSinceMs: number | null
  wedgeRestarts: number
}

const state: SupervisorState = {
  consecutiveFastCrashes: 0,
  notBeforeMs: 0,
  crashLoop: false,
  lastStartMs: null,
  zeroPeersSinceMs: null,
  wedgeRestarts: 0,
}

/** May the keep-alive loop attempt a (re)start right now? */
export function canAttemptStart(nowMs: number): boolean {
  return !state.crashLoop && nowMs >= state.notBeforeMs
}

export function recordStart(nowMs: number): void {
  state.lastStartMs = nowMs
  state.zeroPeersSinceMs = null
}

/** Call when a Bee run ends. Uptime decides crash accounting. */
export function recordExit(nowMs: number): void {
  const uptime = state.lastStartMs === null ? Number.POSITIVE_INFINITY : nowMs - state.lastStartMs

  if (uptime >= FAST_CRASH_MS) {
    // Healthy run (or a deliberate wedge restart) — clean slate.
    state.consecutiveFastCrashes = 0
    state.notBeforeMs = 0

    return
  }

  state.consecutiveFastCrashes++

  if (state.consecutiveFastCrashes >= MAX_FAST_CRASHES) {
    state.crashLoop = true
    logger.error(
      `bee crashed ${state.consecutiveFastCrashes} times in a row (uptime < ${FAST_CRASH_MS / 1000}s) — ` +
        'giving up on automatic restarts. Use Restart in the app to try again.',
    )

    return
  }

  const delay = Math.min(BASE_RESTART_DELAY_MS * 2 ** state.consecutiveFastCrashes, MAX_RESTART_DELAY_MS)
  state.notBeforeMs = nowMs + delay
  logger.warn(
    `bee exited after ${Math.round(uptime / 1000)}s (fast crash ${state.consecutiveFastCrashes}/${MAX_FAST_CRASHES}) — ` +
      `next restart in ${Math.round(delay / 1000)}s`,
  )
}

/** User asked for a fresh start (tray Restart / POST /restart) — forgive everything. */
export function resetCrashLoop(): void {
  state.consecutiveFastCrashes = 0
  state.notBeforeMs = 0
  state.crashLoop = false
}

export interface LivenessProbes {
  /** Connected peer count from the local node, or null when unreachable. */
  getPeerCount: () => Promise<number | null>
  /** Cheap external reachability check. */
  hasInternet: () => Promise<boolean>
}

/**
 * Evaluate the wedge condition. Returns true when the caller should kill Bee
 * (the keep-alive loop then relaunches it). Callers invoke this on their tick
 * only while Bee is running.
 */
export async function shouldRestartForWedge(nowMs: number, probes: LivenessProbes): Promise<boolean> {
  if (state.lastStartMs === null || nowMs - state.lastStartMs < LIVENESS_GRACE_MS) return false

  const peers = await probes.getPeerCount()

  // API unreachable is a different failure (crash detection handles a dead
  // process); only a live API reporting zero peers arms the wedge timer.
  if (peers === null || peers > 0) {
    state.zeroPeersSinceMs = null

    return false
  }

  if (state.zeroPeersSinceMs === null) {
    state.zeroPeersSinceMs = nowMs

    return false
  }

  if (nowMs - state.zeroPeersSinceMs < ZERO_PEERS_LIMIT_MS) return false

  if (!(await probes.hasInternet())) {
    // Host is offline — nothing a restart can fix; keep waiting.
    return false
  }

  state.wedgeRestarts++
  state.zeroPeersSinceMs = null
  logger.error(
    `bee wedged: 0 peers for ${ZERO_PEERS_LIMIT_MS / 60_000}m with internet up — restarting (wedge restart #${state.wedgeRestarts})`,
  )

  return true
}

export function getSupervisorStatus(): { crashLoop: boolean; consecutiveFastCrashes: number; wedgeRestarts: number } {
  return {
    crashLoop: state.crashLoop,
    consecutiveFastCrashes: state.consecutiveFastCrashes,
    wedgeRestarts: state.wedgeRestarts,
  }
}
