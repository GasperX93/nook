import { FileBox, Globe } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { etaText, type TransferEntry } from '../store/transfers'

/**
 * Honest propagation visual (#4 test-run batch): the wait while a deferred
 * upload's chunks are pushed to the network's storers is the longest, most
 * opaque moment in the app — so it becomes the teaching moment. The dot
 * stream's speed follows the REAL confirmed-chunk rate (fast peers = fast
 * dots, a stall = frozen dots), the counter is the tag's real numbers, and
 * the ETA is the coarse rolling-rate estimate. Nothing here animates a lie.
 */

const FACTS = [
  'Your file is split into thousands of encrypted pieces…',
  'Each piece is stored by a different computer on the Swarm network…',
  'No single machine ever holds your whole file…',
  'Once every piece is confirmed, anyone you share with can fetch it…',
]

/** Chunks/second from the entry's recent samples — drives the dot speed. */
function currentRate(t: TransferEntry): number {
  if (t.samples.length < 2) return 0
  const recent = t.samples.slice(-10)
  const [firstTs, firstDone] = recent[0]
  const [lastTs, lastDone] = recent[recent.length - 1]

  if (lastTs === firstTs) return 0

  return (lastDone - firstDone) / ((lastTs - firstTs) / 1000)
}

export default function PropagationVisual({ transfer }: { transfer: TransferEntry }) {
  const [factIdx, setFactIdx] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setFactIdx(i => (i + 1) % FACTS.length), 8000)

    return () => clearInterval(t)
  }, [])

  const rate = currentRate(transfer)
  // Dot travel time: idle 0 (paused), slow trickle 2.6s, brisk 1s.
  const duration = rate <= 0 ? 0 : rate > 400 ? 1 : rate > 100 ? 1.6 : 2.6
  const eta = etaText(transfer)
  const counts = useMemo(() => {
    if (transfer.chunksTotal === undefined || transfer.chunksDone === undefined) return null

    return `${transfer.chunksDone.toLocaleString()} of ${transfer.chunksTotal.toLocaleString()} pieces stored`
  }, [transfer.chunksDone, transfer.chunksTotal])

  return (
    <div className="space-y-2">
      {/* File → network dot stream. Dots pause when no chunks are landing —
          motion means real progress. Hidden for reduced-motion users. */}
      <div className="flex items-center gap-3">
        <FileBox size={16} className="shrink-0" style={{ color: 'rgb(var(--fg-muted))' }} />
        <div className="relative flex-1 h-4 overflow-hidden nook-propagation-track" aria-hidden="true">
          {[0, 1, 2, 3, 4].map(i => (
            <span
              key={i}
              className="nook-propagation-dot"
              style={{
                animationDuration: duration ? `${duration}s` : undefined,
                animationDelay: duration ? `${(i * duration) / 5}s` : undefined,
                animationPlayState: duration ? 'running' : 'paused',
              }}
            />
          ))}
        </div>
        <Globe size={16} className="shrink-0" style={{ color: 'rgb(var(--accent))' }} />
      </div>

      {/* Real numbers: % · piece counts · coarse ETA */}
      <p className="text-xs tabular-nums" style={{ color: 'rgb(var(--fg))' }}>
        <span className="font-semibold">{transfer.pct ?? 0}%</span>
        {counts && <span style={{ color: 'rgb(var(--fg-muted))' }}> · {counts} on the network</span>}
        {eta && <span style={{ color: 'rgb(var(--accent))' }}> · {eta}</span>}
      </p>

      <p className="text-[11px]" style={{ color: 'rgb(var(--fg-muted))' }}>
        {FACTS[factIdx]}
      </p>
    </div>
  )
}
