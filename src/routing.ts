import { delegatedRoutingV1HttpApiClient } from '@helia/delegated-routing-v1-http-api-client'
import { CID } from 'multiformats/cid'
import { defaultLogger } from '@libp2p/logger'
import type { Provider } from './types'

const ROUTER_A_URL = 'https://delegated-ipfs.dev'
const ROUTER_B_URL = 'https://cid.contact'

const logger = defaultLogger()

const routerA = delegatedRoutingV1HttpApiClient({ url: ROUTER_A_URL })({ logger })
const routerB = delegatedRoutingV1HttpApiClient({ url: ROUTER_B_URL })({ logger })

const OVERLOAD_CODES = new Set([429, 502, 503, 504])

export class OverloadError extends Error {
  public router: string
  constructor(public status: number, router: string) {
    super(`HTTP ${status} from ${router}`)
    this.name = 'OverloadError'
    this.router = router
  }
}

/** Single-router lookup. Rotates away from failedRouter when set. */
export async function findProvidersFast(
  cid: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
  failedRouter?: string,
): Promise<Provider[]> {
  const [client, url] = failedRouter === ROUTER_A_URL
    ? [routerB, ROUTER_B_URL]
    : [routerA, ROUTER_A_URL]

  return queryClient(client, url, cid, signal, timeoutMs)
}

/** Parallel dual-router lookup. Queries both routers and merges results. */
export async function findProviders(
  cid: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<Provider[]> {
  const results = await Promise.allSettled([
    queryClient(routerA, ROUTER_A_URL, cid, signal, timeoutMs),
    queryClient(routerB, ROUTER_B_URL, cid, signal, timeoutMs),
  ])

  const seen = new Map<string, Provider>()
  let lastOverload: OverloadError | undefined

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const prov of result.value) {
        if (!seen.has(prov.id)) {
          seen.set(prov.id, prov)
        } else {
          const existing = seen.get(prov.id)!
          const addrSet = new Set([...existing.addrs, ...prov.addrs])
          const protoSet = new Set([...existing.protocols, ...prov.protocols])
          existing.addrs = [...addrSet]
          existing.protocols = [...protoSet]
        }
      }
    } else if (result.reason instanceof OverloadError) {
      lastOverload = result.reason
    }
  }

  if (seen.size > 0) return [...seen.values()]
  if (lastOverload) throw lastOverload

  const firstRejected = results.find(r => r.status === 'rejected') as
    PromiseRejectedResult | undefined
  if (firstRejected) throw firstRejected.reason

  return []
}

type RoutingClient = ReturnType<ReturnType<typeof delegatedRoutingV1HttpApiClient>>

async function queryClient(
  client: RoutingClient,
  routerUrl: string,
  cid: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<Provider[]> {
  const controller = new AbortController()
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal

  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const parsedCid = CID.parse(cid)
    const providers: Provider[] = []

    for await (const peer of client.getProviders(parsedCid, { signal: combinedSignal })) {
      providers.push({
        id: peer.ID.toString(),
        addrs: peer.Addrs.map(a => a.toString()),
        protocols: peer.Protocols,
      })
    }

    return providers
  } catch (err: unknown) {
    if (combinedSignal.aborted) throw err

    const msg = err instanceof Error ? err.message : String(err)
    const statusMatch = msg.match(/(?:status code|HTTP)[:\s]*(\d{3})/)
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0

    if (status === 404) return []
    if (OVERLOAD_CODES.has(status)) throw new OverloadError(status, routerUrl)

    throw new Error(`${routerUrl}: ${msg}`)
  } finally {
    clearTimeout(timer)
  }
}
