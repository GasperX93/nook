jest.mock('env-paths', () =>
  jest.fn().mockImplementation(() => ({
    data: 'test/data/wallet-activity-spec',
    config: 'test/data/wallet-activity-spec',
    cache: 'test/data/wallet-activity-spec',
    log: 'test/data/wallet-activity-spec',
    temp: 'test/data/wallet-activity-spec',
  })),
)
jest.mock('../src/notify', () => ({ createNotification: jest.fn() }))

import { mkdirSync, rmSync, writeFileSync } from 'fs'

import { pushNotification } from '../src/notifications'
import { purchaseCostPlur, recordPurchase } from '../src/purchases'
import { type ActivityFetch, getWalletActivity, resetActivityCacheForTests } from '../src/wallet-activity'

// #139 contract: the activity list merges explorer data with Nook's own
// ledger, labels ONLY what it knows, and degrades to ledger-only honestly.

const ME = 'aa'.repeat(20)
const PEER = '0x' + 'bb'.repeat(20)
const POSTAGE = '0x45a1502382541Cd610CC9068e88727426b696293'

const DATA = 'test/data/wallet-activity-spec'

function setupWallet() {
  mkdirSync(`${DATA}/data-dir/keys`, { recursive: true })
  writeFileSync(`${DATA}/data-dir/keys/swarm.key`, JSON.stringify({ address: ME }))
}

function cleanUp() {
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
  resetActivityCacheForTests()
}

function explorer(overrides: { txs?: unknown[]; transfers?: unknown[]; fail?: boolean }): ActivityFetch {
  return async url => {
    if (overrides.fail) return new Response('nope', { status: 503 })

    if (url.includes('/token-transfers')) {
      return new Response(JSON.stringify({ items: overrides.transfers ?? [] }), { status: 200 })
    }

    return new Response(JSON.stringify({ items: overrides.txs ?? [] }), { status: 200 })
  }
}

// Ledger matching is ±1h around Date.now() — the explorer rows must be 'now'
const T0 = new Date().toISOString()

function bzzTransfer(value: string, from: string, to: string, hash = '0x' + 'cc'.repeat(32)) {
  return {
    transaction_hash: hash,
    timestamp: T0,
    total: { value },
    token: { symbol: 'BZZ' },
    from: { hash: from },
    to: { hash: to },
  }
}

beforeEach(() => {
  cleanUp()
  setupWallet()
})
afterAll(cleanUp)

describe('wallet activity', () => {
  it('maps BZZ transfers with direction and hides zero-value native wrappers', async () => {
    const hash = '0x' + 'dd'.repeat(32)
    const activity = await getWalletActivity(
      explorer({
        transfers: [bzzTransfer('20000000000000000', '0x' + ME, PEER, hash)],
        txs: [{ hash, timestamp: T0, value: '0', from: { hash: '0x' + ME }, to: { hash: PEER } }],
      }),
    )

    expect(activity.degraded).toBe(false)
    expect(activity.rows).toHaveLength(1)
    expect(activity.rows[0]).toMatchObject({ direction: 'out', asset: 'xBZZ', amount: '2.0000', hash })
  })

  it('includes non-zero native xDAI movements', async () => {
    const activity = await getWalletActivity(
      explorer({
        txs: [
          {
            hash: '0x' + 'ee'.repeat(32),
            timestamp: T0,
            value: '1500000000000000000',
            from: { hash: PEER },
            to: { hash: '0x' + ME },
          },
        ],
      }),
    )

    expect(activity.rows[0]).toMatchObject({ direction: 'in', asset: 'xDAI', amount: '1.5000' })
  })

  it('labels an outgoing transfer that matches a ledger event exactly', async () => {
    pushNotification({
      type: 'charge-executed',
      title: 'Extended "Photos"',
      body: '2 xBZZ',
      data: { amountPlur: '20000000000000000' },
    })

    const activity = await getWalletActivity(
      explorer({ transfers: [bzzTransfer('20000000000000000', '0x' + ME, PEER)] }),
    )

    expect(activity.rows[0].label).toBe('Automatic drive extension')
  })

  it('labels postage-contract payments generically, leaves strangers unlabeled', async () => {
    const activity = await getWalletActivity(
      explorer({
        transfers: [
          bzzTransfer('30000000000000000', '0x' + ME, POSTAGE, '0x' + '11'.repeat(32)),
          bzzTransfer('40000000000000000', '0x' + ME, PEER, '0x' + '22'.repeat(32)),
        ],
      }),
    )

    expect(activity.rows.find(r => r.hash?.startsWith('0x11'))?.label).toBe('Drive purchase or extension')
    expect(activity.rows.find(r => r.hash?.startsWith('0x22'))?.label).toBeUndefined()
  })

  it('names the drive on payments matching a purchase record, beating the generic contract label', async () => {
    // purchaseCostPlur('100000', 17) = 100000 × 2^17 — the exact on-chain cost
    recordPurchase({
      kind: 'create',
      batchId: 'ab'.repeat(32),
      label: 'Photos',
      amountPlur: purchaseCostPlur('100000', 17),
    })
    recordPurchase({ kind: 'topup', batchId: 'cd'.repeat(32), label: 'Backups', amountPlur: '999' })

    const activity = await getWalletActivity(
      explorer({
        transfers: [
          bzzTransfer('13107200000', '0x' + ME, POSTAGE, '0x' + '11'.repeat(32)),
          bzzTransfer('999', '0x' + ME, POSTAGE, '0x' + '22'.repeat(32)),
        ],
      }),
    )

    expect(activity.rows.find(r => r.hash?.startsWith('0x11'))?.label).toBe('New drive · Photos')
    expect(activity.rows.find(r => r.hash?.startsWith('0x22'))?.label).toBe('Drive extension · Backups')
  })

  it('names the drive on auto-extend charges that recorded a driveLabel', async () => {
    pushNotification({
      type: 'charge-executed',
      title: 'Extended "Photos"',
      body: '2 xBZZ',
      data: { driveLabel: 'Photos', amountPlur: '20000000000000000' },
    })

    const activity = await getWalletActivity(
      explorer({ transfers: [bzzTransfer('20000000000000000', '0x' + ME, PEER)] }),
    )

    expect(activity.rows[0].label).toBe('Automatic drive extension · Photos')
  })

  it('labels history from chain-decoded calls, naming batches still on the node', async () => {
    const { ethers } = await import('ethers')
    const OWNER = '0x' + '77'.repeat(20)
    const NONCE = '0x' + '99'.repeat(32)
    // Same derivation the contract uses (validated live: abi.encode, not encodePacked)
    const createdId = ethers.utils
      .keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'bytes32'], [OWNER, NONCE]))
      .slice(2)

    const beeStamps: ActivityFetch = async () =>
      new Response(
        JSON.stringify({
          stamps: [
            { batchID: createdId, label: 'Photos' },
            { batchID: 'cd'.repeat(32), label: 'Backups' },
          ],
        }),
        { status: 200 },
      )

    const wrapperTx = (hash: string, method: string, parameters: { name: string; value: string }[]) => ({
      hash,
      timestamp: T0,
      value: '0',
      from: { hash: '0x' + ME },
      to: { hash: POSTAGE },
      method,
      decoded_input: { parameters },
    })

    const activity = await getWalletActivity(
      explorer({
        transfers: [
          bzzTransfer('30000000000000000', '0x' + ME, POSTAGE, '0x' + '11'.repeat(32)),
          bzzTransfer('40000000000000000', '0x' + ME, POSTAGE, '0x' + '22'.repeat(32)),
          bzzTransfer('50000000000000000', '0x' + ME, POSTAGE, '0x' + '33'.repeat(32)),
        ],
        txs: [
          wrapperTx('0x' + '11'.repeat(32), 'createBatch', [
            { name: '_owner', value: OWNER },
            { name: '_nonce', value: NONCE },
          ]),
          wrapperTx('0x' + '22'.repeat(32), 'topUp', [{ name: '_batchId', value: '0x' + 'cd'.repeat(32) }]),
          // Batch no longer on the node — labeled, but not named
          wrapperTx('0x' + '33'.repeat(32), 'topUp', [{ name: '_batchId', value: '0x' + 'ee'.repeat(32) }]),
        ],
      }),
      beeStamps,
    )

    const byHash = (prefix: string) => activity.rows.find(r => r.hash?.startsWith(prefix))?.label

    expect(byHash('0x1111')).toBe('New drive · Photos')
    expect(byHash('0x2222')).toBe('Drive extension · Backups')
    expect(byHash('0x3333')).toBe('Drive extension')
  })

  it('degrades to ledger-only rows when the explorer is down', async () => {
    pushNotification({
      type: 'chequebook-funded',
      title: 'Chequebook topped up',
      body: '',
      data: { amountPlur: '5000000000000000' },
    })

    const activity = await getWalletActivity(explorer({ fail: true }))

    expect(activity.degraded).toBe(true)
    expect(activity.rows).toHaveLength(1)
    expect(activity.rows[0]).toMatchObject({ label: 'Chequebook top-up (bandwidth)', amount: '0.5000' })
    expect(activity.rows[0].hash).toBeUndefined()
  })
})
