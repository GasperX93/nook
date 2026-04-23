import { Bee, PrivateKey, Topic, type BatchId, type Reference } from '@ethersphere/bee-js'

export interface DriveFeedEntry {
  v: 1
  historyRef: string
  encryptedRef: string
  memberListRef?: string
  ts: number
}

export interface WriteEntryArgs {
  bee: Bee
  stamp: BatchId | string
  topicHex: string
  writeKeyPriv: Uint8Array
  entry: Omit<DriveFeedEntry, 'v' | 'ts'>
}

export interface ReadLatestArgs {
  bee: Bee
  topicHex: string
  ownerAddress: string
}

export async function readLatestEntry(args: ReadLatestArgs): Promise<DriveFeedEntry | null> {
  const reader = args.bee.makeFeedReader(new Topic(args.topicHex), args.ownerAddress)
  try {
    const result = await reader.downloadPayload()
    const text = new TextDecoder().decode(result.payload.toUint8Array())
    const parsed = JSON.parse(text) as DriveFeedEntry
    if (parsed.v !== 1) throw new Error(`driveFeed: unsupported entry version ${parsed.v}`)
    return parsed
  } catch (err) {
    if (isNotFoundError(err)) return null
    throw err
  }
}

export async function writeEntry(args: WriteEntryArgs): Promise<Reference> {
  const payload: DriveFeedEntry = {
    v: 1,
    historyRef: args.entry.historyRef,
    encryptedRef: args.entry.encryptedRef,
    memberListRef: args.entry.memberListRef,
    ts: Math.floor(Date.now() / 1000),
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const writer = args.bee.makeFeedWriter(new Topic(args.topicHex), new PrivateKey(args.writeKeyPriv))
  const result = await writer.uploadPayload(args.stamp, bytes)
  return result.reference
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const msg = String((err as { message?: string }).message ?? '').toLowerCase()
  return msg.includes('not found') || msg.includes('404')
}
