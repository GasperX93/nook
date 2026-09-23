/**
 * Who we removed from which drive (R4-16), so sharing that drive with them
 * again sends "Access restored" instead of a fresh "Drive shared" — they
 * already have the drive; it should just come back.
 *
 * Namespaced per identity (contacts are). Keyed by drive batch id → contact ids.
 */
import { nsKey } from './active-identity'

const KEY = 'nook-drive-removed-v1'

type RemovedMap = Record<string, string[]>

function load(): RemovedMap {
  try {
    return JSON.parse(localStorage.getItem(nsKey(KEY)) ?? '{}') as RemovedMap
  } catch {
    return {}
  }
}

function save(map: RemovedMap): void {
  try {
    localStorage.setItem(nsKey(KEY), JSON.stringify(map))
  } catch {
    // best effort — worst case the re-share reads "Drive shared"
  }
}

export function markRemovedFromDrive(driveId: string, contactId: string): void {
  const map = load()
  const d = driveId.toLowerCase()
  const ids = new Set(map[d] ?? [])

  ids.add(contactId.toLowerCase())
  map[d] = [...ids]
  save(map)
}

export function wasRemovedFromDrive(driveId: string, contactId: string): boolean {
  return (load()[driveId.toLowerCase()] ?? []).includes(contactId.toLowerCase())
}

export function clearRemovedFromDrive(driveId: string, contactId: string): void {
  const map = load()
  const d = driveId.toLowerCase()

  map[d] = (map[d] ?? []).filter(id => id !== contactId.toLowerCase())

  if (map[d].length === 0) delete map[d]
  save(map)
}
