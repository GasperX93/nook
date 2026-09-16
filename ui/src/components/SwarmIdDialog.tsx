import { useEffect, useRef, useState } from 'react'

import { isSignInDialogOpen, onSignInDialog, setSignInDialogOpen, SWARM_ID_FRAME_CONTAINER_ID } from '../swarm-id'

/**
 * Sign-in dialog for Swarm ID (spike/swarm-id-only).
 *
 * Hosts the SDK's own "Login with Swarm ID" button — the user must click THAT
 * button (not one of ours) so the auth popup is opened from inside the SDK
 * iframe and session handover works under partitioned storage. Mounted
 * permanently in Layout: remounting the container would break the popup's
 * receiver. Pattern from the apiritivo reference integration.
 */
export default function SwarmIdDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(isSignInDialogOpen())

  useEffect(() => onSignInDialog(setOpen), [])

  useEffect(() => {
    const dialog = ref.current

    if (!dialog) return

    if (open && !dialog.open) dialog.showModal()

    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby="swarm-id-dialog-title"
      onCancel={() => setSignInDialogOpen(false)}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border p-6 backdrop:bg-black/60"
      style={{
        backgroundColor: 'rgb(var(--bg-surface))',
        borderColor: 'rgb(var(--border))',
        color: 'rgb(var(--fg))',
      }}
    >
      <p className="text-xs uppercase tracking-widest" style={{ color: 'rgb(var(--fg-muted))' }}>
        Swarm ID
      </p>
      <h2 id="swarm-id-dialog-title" className="mt-2 text-lg font-semibold">
        Sign in
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
        Use the Swarm ID button below, then approve Nook in the window that opens.
      </p>
      {/* The SDK renders its login button into this host. Keep it mounted. */}
      <div id={SWARM_ID_FRAME_CONTAINER_ID} className="my-5 h-20 w-full" />
      <div className="flex justify-end">
        <button
          onClick={() => setSignInDialogOpen(false)}
          className="text-sm px-3 py-1.5 rounded-lg transition-colors hover:bg-white/5"
          style={{ color: 'rgb(var(--fg-muted))' }}
        >
          Cancel
        </button>
      </div>
    </dialog>
  )
}
