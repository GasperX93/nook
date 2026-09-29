/**
 * Logs page (R4-18) — reachable by everyone (the Bee-down and crash-loop
 * banners link here); Developer mode shows the same viewer beside the config.
 */
import LogViewer from '../components/LogViewer'

export default function Logs() {
  return (
    <div className="flex flex-col p-6 gap-4 h-full min-h-0">
      <div>
        <h2 className="text-lg font-semibold">Logs</h2>
        <p className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
          What your Bee node and Nook are doing. If something goes wrong, download the log and include it in your
          report.
        </p>
      </div>
      <LogViewer className="flex-1" />
    </div>
  )
}
