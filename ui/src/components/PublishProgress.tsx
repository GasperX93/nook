/**
 * Publish-a-website progress (R4-7): the steps in order, the current one
 * highlighted, and only HONEST progress — the real % while copying to the
 * node, the real propagation visual while storing on the network. Steps with
 * nothing to measure (buying storage, getting it ready, the permanent
 * address) show elapsed time and a rotating fact instead of a fake bar.
 */
import { Check } from 'lucide-react'
import { useEffect, useState } from 'react'

import { UPLOAD_PAUSED, UPLOAD_RESUMING, UPLOAD_STEP_LOCAL, UPLOAD_STEP_NETWORK } from '../lib/transfer-labels'
import type { TransferEntry } from '../store/transfers'
import PropagationVisual from './PropagationVisual'

type StepId = 'buy' | 'ready' | 'copy' | 'store' | 'feed'

const STEP_LABEL: Record<StepId, string> = {
  buy: 'Buy storage',
  ready: 'Get storage ready',
  copy: 'Copy to your Bee node',
  store: 'Store on the Swarm network',
  feed: 'Create the permanent address',
}

const FACTS = [
  'Your site will live on Swarm, not on a server — nobody can take it down.',
  'Storage is paid upfront — no subscription.',
  'Every file is split into pieces and spread across Bee nodes worldwide.',
  'With a permanent address, updating the site keeps the same link.',
]

/** Which step a phase string belongs to (phases come from useUpload / the publisher). */
function stepOf(phase: string): StepId {
  if (phase.startsWith('Buying')) return 'buy'

  if (phase === UPLOAD_STEP_LOCAL || phase.startsWith('Encrypting')) return 'copy'

  if (phase === UPLOAD_STEP_NETWORK || phase.startsWith('Still storing')) return 'store'

  if (phase.startsWith('Creating the permanent address')) return 'feed'

  return 'ready'
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000)

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

interface Props {
  phase: string
  /** The last real step's phase (kept by the publish job) — what a pause interrupted. */
  stepPhase?: string
  fileCount: number
  uploadProgress: number | null
  propagationTransfer?: TransferEntry
  skippedBuy: boolean
  feedEnabled: boolean
}

export default function PublishProgress({
  phase,
  stepPhase,
  fileCount,
  uploadProgress,
  propagationTransfer,
  skippedBuy,
  feedEnabled,
}: Props) {
  // Paused / resuming (R8-3) isn't a step of its own — the list stays on the
  // step the outage interrupted instead of jumping back to "Get storage ready".
  // The job remembers that step, so it holds even if the page is reopened mid-pause.
  const waiting = phase === UPLOAD_PAUSED || phase === UPLOAD_RESUMING
  const current = stepOf(waiting && stepPhase ? stepPhase : phase)
  const steps: StepId[] = [
    ...(skippedBuy ? [] : ['buy' as const]),
    'ready',
    'copy',
    'store',
    ...(feedEnabled ? ['feed' as const] : []),
  ]
  const currentIdx = steps.indexOf(current)

  // Elapsed time for the current step; resets when the step changes.
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => setStartedAt(Date.now()), [current])
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(id)
  }, [])

  const factIdx = Math.floor(now / 8000) % FACTS.length
  const measurable = current === 'copy' || (current === 'store' && propagationTransfer)
  // One timer (R5-5): when the phase carries its own countdown ("Preparing
  // storage… 37s"), the step list doesn't add a second, disagreeing clock.
  const phaseHasCountdown = /\d+s$/.test(phase)
  // The step list already says where we are — drop "Step N of 2 · ".
  const phaseText = phase.replace(/^Step \d+ of \d+ · /, '')

  return (
    <div className="flex flex-col gap-5 py-10 max-w-md mx-auto w-full">
      <ol className="space-y-2 text-sm">
        {steps.map((id, i) => {
          const done = i < currentIdx
          const active = i === currentIdx

          return (
            <li
              key={id}
              className="flex items-center gap-2"
              style={{
                color: done ? '#16a34a' : active ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))',
                fontWeight: active ? 600 : 400,
              }}
            >
              <span className="w-4 flex justify-center">
                {done ? (
                  <Check size={14} />
                ) : (
                  <span
                    className={`w-2 h-2 rounded-full ${active ? 'animate-pulse' : ''}`}
                    style={{ backgroundColor: active ? 'rgb(var(--accent))' : 'rgb(var(--border))' }}
                  />
                )}
              </span>
              {STEP_LABEL[id]}
              {active && !measurable && !phaseHasCountdown && (
                <span className="ml-auto text-xs tabular-nums font-normal" style={{ color: 'rgb(var(--fg-muted))' }}>
                  {mmss(now - startedAt)}
                </span>
              )}
            </li>
          )
        })}
      </ol>

      <div
        className="rounded-xl border p-4 space-y-3"
        style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: 'rgb(var(--border))' }}
      >
        <p className="text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          {phaseText || 'Publishing…'}
          {fileCount > 0 && current !== 'store' && ` · ${fileCount} files`}
        </p>

        {current === 'store' && propagationTransfer ? (
          <PropagationVisual transfer={propagationTransfer} subject="site" />
        ) : current === 'copy' && uploadProgress !== null ? (
          <div className="space-y-1.5">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgb(var(--border))' }}>
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{ width: `${uploadProgress}%`, backgroundColor: 'rgb(var(--accent))' }}
              />
            </div>
            <p className="text-xs tabular-nums" style={{ color: 'rgb(var(--fg-muted))' }}>
              {uploadProgress}%
            </p>
          </div>
        ) : (
          <>
            {current === 'buy' && (
              <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                This usually takes 1–3 minutes — Nook is paying for the space on the Swarm network.
              </p>
            )}
            <p className="text-xs italic" style={{ color: 'rgb(var(--fg-muted))' }}>
              {FACTS[factIdx]}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
