/**
 * The bubbles of one conversation, laid out the way chat apps do it:
 * own messages on the right in a grey fill, the other person's on the left
 * in an outlined bubble (two greys — the app stays black and white),
 * the time inside each bubble, messages from one person within a few minutes
 * stacked tightly, and a pill between days.
 */
import { Fragment, type ReactNode } from 'react'

import type { StoredMessage } from '../notify/messages'
import DriveMessageCard from './DriveMessageCard'

/** Messages from one person less than this apart sit together as one group. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function isSameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** Label for the pill between days: Today, Yesterday, or the date. */
function dayLabel(ts: number): string {
  const now = Date.now()

  if (isSameDay(ts, now)) return 'Today'

  if (isSameDay(ts, now - 24 * 60 * 60 * 1000)) return 'Yesterday'
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()

  return d.toLocaleDateString([], { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
}

function isDriveCard(m: StoredMessage | undefined): boolean {
  return Boolean(m?.kind && m.kind !== 'message' && m.driveShareLink)
}

interface Props {
  thread: StoredMessage[]
  /** The other person's nickname */
  counterpartName: string
  onAddDrive: (link: string, driveName?: string) => void
  onOpenDrive: () => void
  /** Delivery footer for a sent message (sending… / retry); null when there is nothing to say. */
  renderStatus: (m: StoredMessage) => ReactNode
}

export default function MessageThread({ thread, counterpartName, onAddDrive, onOpenDrive, renderStatus }: Props) {
  return (
    <>
      {thread.map((m, i) => {
        const prev = thread[i - 1]
        const newDay = !prev || !isSameDay(prev.ts, m.ts)
        const isCard = isDriveCard(m)
        // Same person, same day, within a few minutes: stack tightly.
        const grouped =
          prev !== undefined &&
          !newDay &&
          !isCard &&
          !isDriveCard(prev) &&
          prev.direction === m.direction &&
          m.ts - prev.ts < GROUP_WINDOW_MS
        // The day pill carries its own spacing; otherwise tight inside a group.
        let gap = grouped ? 'mt-0.5' : 'mt-3'

        if (i === 0 || newDay) gap = ''
        const sent = m.direction === 'sent'
        const dayPill = newDay ? (
          <p
            className={`self-center rounded-full px-3 py-0.5 text-[10px] bg-muted text-muted-foreground mb-3 ${
              i === 0 ? '' : 'mt-4'
            }`}
          >
            {dayLabel(m.ts)}
          </p>
        ) : null

        if (isCard) {
          return (
            <Fragment key={m.id}>
              {dayPill}
              <div className={`flex flex-col ${gap}`}>
                <DriveMessageCard
                  m={m}
                  counterpartName={counterpartName}
                  time={clockTime(m.ts)}
                  onAdd={onAddDrive}
                  onOpen={onOpenDrive}
                  status={renderStatus(m)}
                />
              </div>
            </Fragment>
          )
        }

        return (
          <Fragment key={m.id}>
            {dayPill}
            <div className={`max-w-[70%] flex flex-col ${sent ? 'self-end items-end' : 'self-start'} ${gap}`}>
              <div
                className={`max-w-full rounded-2xl px-3 py-1.5 flex items-end gap-x-2 text-foreground ${
                  sent ? 'bg-[#e5e5e5] dark:bg-[#2c3140]' : 'bg-background border'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words min-w-0 flex-1">{m.body}</p>
                <span className="text-[10px] leading-5 opacity-60 shrink-0" title={new Date(m.ts).toLocaleString()}>
                  {clockTime(m.ts)}
                </span>
              </div>
              {renderStatus(m)}
            </div>
          </Fragment>
        )
      })}
    </>
  )
}
