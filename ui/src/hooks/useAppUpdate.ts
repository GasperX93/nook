import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { serverApi } from '../api/server'

/**
 * A newer Nook, and the one Update button for it (sidebar + Settings).
 * On Mac and Windows the update downloads in the background and Update
 * restarts Nook into it (server update-checker.ts); elsewhere the button is a
 * download link. While Nook restarts, the page reloads itself once the new
 * version answers, so the dashboard isn't left on the old code.
 */
export function useAppUpdate() {
  const queryClient = useQueryClient()
  const [clicked, setClicked] = useState(false)
  const { data: info } = useQuery({
    queryKey: ['server', 'update'],
    queryFn: serverApi.getUpdateInfo,
    // A local call: every minute, so the button turns into Update soon after
    // the updater finds a version; faster while it downloads or a click waits.
    refetchInterval: query =>
      query.state.data?.installRequested || query.state.data?.updater === 'downloading' ? 5_000 : 60_000,
    retry: false,
  })

  const available = Boolean(info?.updateAvailable)
  const canInstall =
    available && (info?.updater === 'downloading' || info?.updater === 'ready' || info?.updater === 'installing')
  // Hung download (server STUCK_AFTER_MS): the link, and a restart retries it.
  const stuck = available && info?.updater === 'stuck'
  const busy = canInstall && (clicked || Boolean(info?.installRequested) || info?.updater === 'installing')
  const current = info?.current

  // Restarting: reload as soon as a different version answers.
  useEffect(() => {
    if (!busy || !current) return
    const timer = setInterval(async () => {
      try {
        const response = await fetch('/info')
        const { version } = (await response.json()) as { version?: string }

        if (version && version !== current) window.location.reload()
      } catch {
        // Nook is down mid-restart — keep asking.
      }
    }, 3_000)

    return () => clearInterval(timer)
  }, [busy, current])

  async function update() {
    setClicked(true)
    try {
      await serverApi.installUpdate()
    } catch {
      setClicked(false)
    }
    await queryClient.invalidateQueries({ queryKey: ['server', 'update'] })
  }

  return { info, available, canInstall, stuck, busy, update }
}
