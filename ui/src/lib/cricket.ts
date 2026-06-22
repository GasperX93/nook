/**
 * Cricket chirp synth — short 4-burst pattern of ~5kHz sine waves with an
 * AD envelope. No audio asset, no network — generated via Web Audio API.
 *
 * Browsers block AudioContext until the first user gesture. The Settings
 * toggle click counts as a gesture, so the context unlocks once on opt-in
 * and stays unlocked for the rest of the tab session.
 */

let ctx: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null

  if (ctx) return ctx
  const AC =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext

  if (!AC) return null
  ctx = new AC()

  return ctx
}

let primed = false

/**
 * Unlock the AudioContext on the first user gesture. Without this, the very
 * first chirp (often a *background* poll — e.g. an incoming invitation) tries
 * to create + resume the context with no recent gesture, which the browser
 * rejects, so it's silent. Priming on the first click/keypress means the
 * context is already running before any background chirp fires. Call once.
 */
export function primeCricketAudio(): void {
  if (primed || typeof window === 'undefined') return
  primed = true
  const unlock = () => {
    const audio = getContext()

    if (audio && audio.state === 'suspended') void audio.resume()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }

  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

export function playCricketChirp(): void {
  const audio = getContext()

  if (!audio) return

  // Resume if suspended by browser autoplay policy
  if (audio.state === 'suspended') void audio.resume()

  const now = audio.currentTime
  // 4 chirps, ~70ms each, separated by ~60ms gaps
  for (let i = 0; i < 4; i++) {
    const start = now + i * 0.13
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(4800, start)
    osc.frequency.exponentialRampToValueAtTime(5200, start + 0.06)
    // Attack-decay envelope: 5ms rise, 65ms fall, peak 0.08 to stay subtle
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(0.08, start + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.07)
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start(start)
    osc.stop(start + 0.08)
  }
}
