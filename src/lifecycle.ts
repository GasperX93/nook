interface State {
  process: Promise<number | void> | null
  running: boolean
  shouldRun: boolean
  abortController: AbortController | null
  /** Set true the first time Bee starts; lets the UI distinguish "boot" from "user stopped" */
  wasEverStarted: boolean
}

const state: State = {
  process: null,
  running: false,
  shouldRun: false,
  abortController: null,
  wasEverStarted: false,
}

export const BeeManager = {
  setUserIntention: (newState: boolean) => {
    state.shouldRun = newState
  },
  shouldRestart: () => state.shouldRun,
  wasEverStarted: () => state.wasEverStarted,
  signalRunning: (abortController: AbortController, process: Promise<number | void>) => {
    state.abortController = abortController
    state.process = process
    state.running = true
    state.wasEverStarted = true
  },
  signalStopped: () => {
    state.running = false
  },
  isRunning: () => state.running || (state.abortController && !state.abortController.signal.aborted),
  stop: () => {
    state.shouldRun = false

    if (state.abortController) {
      state.abortController.abort()
    }
  },
  /**
   * Kill the Bee process WITHOUT clearing the run intention — the keep-alive
   * loop relaunches it on its next tick. `stop()` is user intent ("keep it
   * off"); this is supervision ("bounce it"). Used by the wedge restart.
   */
  kill: () => {
    if (state.abortController) {
      state.abortController.abort()
    }
  },
  waitForSigtermToFinish: async () => {
    if (state.process) {
      await state.process
    }
  },
}
