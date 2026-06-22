import { useState } from 'react'

import Identity from './Identity'
import Wallet from './Wallet'

type AccountTab = 'wallet' | 'identity'

export default function Account() {
  const [tab, setTab] = useState<AccountTab>('wallet')

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex gap-1 mb-6 border-b" style={{ borderColor: 'rgb(var(--border))' }}>
        {(['wallet', 'identity'] as AccountTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-4 py-2 text-sm font-medium transition-colors relative capitalize"
            style={{ color: tab === t ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))' }}
          >
            {t}
            {tab === t && (
              <span
                className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t"
                style={{ backgroundColor: 'rgb(var(--accent))' }}
              />
            )}
          </button>
        ))}
      </div>

      {tab === 'wallet' && <Wallet />}
      {tab === 'identity' && <Identity />}
    </div>
  )
}
