/**
 * Dev-only preview of the chat layout with made-up messages (route
 * `#/dev/chat-preview`, registered in App.tsx only under `import.meta.env.DEV`).
 * Nothing here reads or writes contacts, threads or the network — it exists so
 * the bubbles can be looked at without messaging a real person.
 */
import { useState } from 'react'

import MessageThread from '../components/MessageThread'
import type { StoredMessage } from '../notify/messages'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function sample(): StoredMessage[] {
  const now = Date.now()
  let n = 0
  const msg = (ago: number, direction: 'sent' | 'received', body: string, extra: Partial<StoredMessage> = {}) => ({
    id: `preview-${n++}`,
    counterparty: '0x0000000000000000000000000000000000000000',
    ts: now - ago,
    body,
    direction,
    ...extra,
  })

  return [
    msg(2 * DAY + 3 * HOUR, 'received', 'hey, did you get the folder?'),
    msg(2 * DAY + 3 * HOUR - MIN, 'received', 'the one with the photos'),
    msg(2 * DAY + 3 * HOUR - 2 * MIN, 'received', 'from the weekend'),
    msg(2 * DAY + 2 * HOUR, 'sent', 'not yet'),
    msg(2 * DAY + 2 * HOUR - MIN, 'sent', 'can you share it again?'),
    msg(2 * DAY + HOUR, 'received', 'Family photos', {
      kind: 'drive-share',
      driveShareLink: `nook://drive-share?topic=${'a'.repeat(64)}&owner=${'b'.repeat(40)}&publisher=${'c'.repeat(66)}`,
      driveName: 'Family photos',
      fileCount: 42,
    }),
    msg(2 * DAY + 50 * MIN, 'sent', 'got it, thanks!'),

    msg(DAY + 5 * HOUR, 'received', 'one more thing'),
    msg(
      DAY + 5 * HOUR - MIN,
      'received',
      'When you upload the big video, do it on wifi. It took me almost an hour on the phone hotspot, and the progress bar sat at the same place for a long time before it moved again. It did finish in the end.',
    ),
    msg(DAY + 4 * HOUR, 'sent', 'ok'),
    msg(DAY + 4 * HOUR - MIN, 'sent', 'good to know'),
    msg(
      DAY + 4 * HOUR - 2 * MIN,
      'sent',
      'I will try tonight and tell you how long it takes here. If it is slow again we can look at the logs together tomorrow.',
    ),

    msg(40 * MIN, 'received', 'morning'),
    msg(39 * MIN, 'received', 'are you around?'),
    msg(30 * MIN, 'sent', 'yes'),
    msg(29 * MIN, 'sent', 'give me 5 min'),
    msg(12 * MIN, 'received', 'line one\nline two\nline three'),
    msg(3 * MIN, 'sent', 'this one is still on its way', { status: 'sending' }),
    msg(2 * MIN, 'sent', 'and this one failed', { status: 'failed' }),
  ]
}

// Same look as the delivery footer in Messages.tsx, without the retry wiring.
function previewStatus(m: StoredMessage) {
  if (m.direction !== 'sent' || !m.status || m.status === 'sent') return null

  if (m.status === 'sending') {
    return <p className="text-[10px] mt-0.5 text-right italic text-muted-foreground">sending…</p>
  }

  return (
    <button className="text-[10px] mt-0.5 block ml-auto" style={{ color: '#ef4444' }}>
      not sent — tap to retry
    </button>
  )
}

// Looks to compare for own / their bubbles. `undefined` = the component's default.
const LOOKS: { name: string; own?: string; their?: string }[] = [
  { name: 'Dark (current)' },
  { name: 'A · Soft tint', own: 'bg-[#d9e9f6] text-[#0a0a0a] dark:bg-[#20385a] dark:text-[#f0f4f8]' },
  {
    name: 'B · Two greys',
    own: 'bg-[#e5e5e5] text-[#0a0a0a] dark:bg-[#2c3140] dark:text-[#f0f4f8]',
    their: 'bg-background border text-foreground',
  },
  { name: 'C · Softer dark', own: 'bg-[#3f3f46] text-white dark:bg-[#d4d4d8] dark:text-[#0a0a0a]' },
]

export default function ChatPreview() {
  const [look, setLook] = useState(0)
  const [thread] = useState(sample)

  return (
    <div className="flex flex-col h-full max-w-3xl">
      <div className="px-6 py-3 border-b" style={{ borderColor: 'rgb(var(--border))' }}>
        <h2 className="text-base font-semibold" style={{ color: 'rgb(var(--fg))' }}>
          Chat preview
        </h2>
        <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
          Made-up messages. Nothing here is saved or sent.
        </p>
        <div className="flex flex-wrap gap-2 mt-2">
          {LOOKS.map((l, i) => (
            <button
              key={l.name}
              onClick={() => setLook(i)}
              className={`text-xs rounded-full border px-3 py-1 ${i === look ? 'bg-primary text-primary-foreground' : ''}`}
              style={{ borderColor: 'rgb(var(--border))' }}
            >
              {l.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4 flex flex-col">
        <MessageThread
          thread={thread}
          counterpartName="Novak"
          onAddDrive={() => undefined}
          onOpenDrive={() => undefined}
          renderStatus={previewStatus}
          ownClassName={LOOKS[look].own}
          theirClassName={LOOKS[look].their}
        />
      </div>
    </div>
  )
}
