/**
 * Thread card for drive messages (R4-15/16):
 * - drive-share: "Add drive", or "Open" when the drive is already in Shared with me
 * - drive-access-removed: a calm note, no action
 * - drive-access-restored: "Open" — the drive re-syncs by itself
 */
import { FileText, Lock, Unlock } from 'lucide-react'
import type { ReactNode } from 'react'

import { findSharedDriveForLink } from '../notify/drive-access'
import type { StoredMessage } from '../notify/messages'
import { Button } from './ui/button'

interface Props {
  m: StoredMessage
  /** The other person's nickname */
  counterpartName: string
  time: string
  onAdd: (link: string) => void
  onOpen: () => void
  status?: ReactNode
}

export default function DriveMessageCard({ m, counterpartName, time, onAdd, onOpen, status }: Props) {
  const isSent = m.direction === 'sent'
  const name = m.driveName ?? 'Encrypted drive'
  const haveIt = !isSent && Boolean(findSharedDriveForLink(m.driveShareLink))

  let icon = <FileText size={14} />
  let tone = 'rgb(var(--accent))'
  let label: string
  let text: ReactNode = (
    <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
      {m.fileCount ?? 0} file{m.fileCount === 1 ? '' : 's'}
    </p>
  )
  let action: ReactNode = null

  if (m.kind === 'drive-access-removed') {
    icon = <Lock size={14} />
    tone = '#ef4444'
    label = 'Access removed'
    text = (
      <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
        {isSent ? (
          <>You removed {counterpartName}&apos;s access.</>
        ) : (
          <>
            {counterpartName} removed your access to <b>{name}</b>. Files you already downloaded stay with you.
          </>
        )}
      </p>
    )
  } else if (m.kind === 'drive-access-restored') {
    icon = <Unlock size={14} />
    tone = '#16a34a'
    label = 'Access restored'
    text = (
      <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
        {isSent ? <>{counterpartName} can open this drive again.</> : <>You can open this drive again.</>}
      </p>
    )

    if (!isSent) {
      action = (
        <Button onClick={onOpen} size="sm" variant="outline" className="w-full">
          Open
        </Button>
      )
    }
  } else {
    label = isSent ? 'Drive shared' : haveIt ? 'Drive updated' : 'Drive shared with you'

    if (!isSent) {
      action = haveIt ? (
        <Button onClick={onOpen} size="sm" variant="outline" className="w-full">
          Open
        </Button>
      ) : (
        <Button onClick={() => m.driveShareLink && onAdd(m.driveShareLink)} size="sm" className="w-full">
          Add drive
        </Button>
      )
    }
  }

  return (
    <div
      className={`max-w-[80%] rounded-2xl border px-4 py-3 space-y-2 ${isSent ? 'self-end' : 'self-start'}`}
      style={{ backgroundColor: 'rgb(var(--bg-surface))', borderColor: tone, color: 'rgb(var(--fg))' }}
    >
      <div className="flex items-center gap-2" style={{ color: tone }}>
        {icon}
        <span className="text-xs uppercase tracking-widest">{label}</span>
      </div>
      <div>
        <p className="text-sm font-semibold">{name}</p>
        {text}
      </div>
      {action}
      <p className="text-[10px]" style={{ color: 'rgb(var(--fg-muted))' }}>
        {time}
      </p>
      {status}
    </div>
  )
}
