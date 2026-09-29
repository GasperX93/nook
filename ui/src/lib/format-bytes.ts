/**
 * One unit system for every size in the app (R7-6): decimal, like the drive
 * sizes people buy ("2.6 GB") and like Finder. Dividing by 1024 in some
 * places made a "2.6 GB" drive show as "2.4 GB" in the list.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`

  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`

  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`

  return `${bytes} B`
}
