export interface GeoPlace {
  lat: number
  lng: number
  city: string
  region: string
  country: string
}

export interface ProviderLocation {
  ip: string | null
  relay: boolean
  place: GeoPlace | null
  status: 'located' | 'private' | 'none' | 'unavailable'
}

type Family = 'ip4' | 'ip6' | 'dns4' | 'dns6' | 'dns'

interface Candidate {
  host: string
  family: Family
  relay: boolean
  private: boolean
}

const geoCache = new Map<string, GeoPlace | null>()
const dnsCache = new Map<string, string | null>()
const geoInflight = new Map<string, Promise<GeoPlace | null>>()
const dnsInflight = new Map<string, Promise<string | null>>()

const V4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const V6 = /^[0-9a-f:]+$/i

export function formatPlace(place: GeoPlace): string {
  const parts: string[] = []
  for (const bit of [place.city, place.region, place.country]) {
    const value = bit.trim()
    if (!value) continue
    if (parts.some(part => part.toLowerCase() === value.toLowerCase())) continue
    parts.push(value)
  }
  return parts.join(', ')
}

export async function locateProvider(addrs: string[]): Promise<ProviderLocation> {
  const picked = pick(addrs)
  if (!picked) return { ip: null, relay: false, place: null, status: 'none' }
  if (picked.private) {
    const ip = picked.family === 'ip4' || picked.family === 'ip6' ? picked.host : null
    return { ip, relay: picked.relay, place: null, status: 'private' }
  }

  try {
    const ip = await toPublicIp(picked)
    if (!ip) return { ip: null, relay: picked.relay, place: null, status: 'unavailable' }
    if (isPrivateIp(ip)) return { ip, relay: picked.relay, place: null, status: 'private' }
    const place = await geolocate(ip)
    if (!place) return { ip, relay: picked.relay, place: null, status: 'unavailable' }
    return { ip, relay: picked.relay, place, status: 'located' }
  } catch {
    return { ip: null, relay: picked.relay, place: null, status: 'unavailable' }
  }
}

function pick(addrs: string[]): Candidate | null {
  let best: Candidate | null = null
  let bestRank = Infinity
  for (const addr of addrs) {
    const candidate = candidateFrom(addr)
    if (!candidate) continue
    const rank = rankOf(candidate)
    if (rank < bestRank) {
      best = candidate
      bestRank = rank
    }
  }
  return best
}

function candidateFrom(addr: string): Candidate | null {
  const relay = addr.includes('/p2p-circuit')
  const ip4 = addr.match(/\/ip4\/(\d{1,3}(?:\.\d{1,3}){3})(?=\/|$)/)
  if (ip4 && parseV4(ip4[1])) {
    return { host: ip4[1], family: 'ip4', relay, private: isPrivateV4(ip4[1]) }
  }
  const ip6 = addr.match(/\/ip6\/([^/]+)(?=\/|$)/)
  if (ip6 && V6.test(ip6[1])) {
    return { host: ip6[1], family: 'ip6', relay, private: isPrivateV6(ip6[1]) }
  }
  const dns4 = addr.match(/\/dns4\/([^/]+)(?=\/|$)/)
  if (dns4) return named(dns4[1], 'dns4', relay)
  const dns6 = addr.match(/\/dns6\/([^/]+)(?=\/|$)/)
  if (dns6) return named(dns6[1], 'dns6', relay)
  const dns = addr.match(/\/dns\/([^/]+)(?=\/|$)/)
  if (dns) return named(dns[1], 'dns', relay)
  return null
}

function named(host: string, family: Family, relay: boolean): Candidate {
  return { host, family, relay, private: isLocalName(host) }
}

function rankOf(candidate: Candidate): number {
  if (candidate.private) return 100
  let score = candidate.relay ? 10 : 0
  if (candidate.family === 'ip6') score += 1
  if (candidate.family === 'dns4' || candidate.family === 'dns') score += 2
  if (candidate.family === 'dns6') score += 3
  return score
}

async function toPublicIp(candidate: Candidate): Promise<string | null> {
  if (candidate.family === 'ip4' || candidate.family === 'ip6') return candidate.host
  if (candidate.family === 'dns6') {
    return (await resolveHost(candidate.host, 'AAAA')) ?? resolveHost(candidate.host, 'A')
  }
  const v4 = await resolveHost(candidate.host, 'A')
  if (v4 || candidate.family === 'dns4') return v4
  return resolveHost(candidate.host, 'AAAA')
}

function resolveHost(host: string, kind: 'A' | 'AAAA'): Promise<string | null> {
  const type = kind === 'A' ? 1 : 28
  const key = `${kind}:${host.toLowerCase()}`
  return cached(dnsCache, dnsInflight, key, async () => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${kind}`
    const body = await fetchJson(url, { accept: 'application/dns-json' })
    const answers = Array.isArray(body?.Answer) ? body.Answer : []
    for (const answer of answers) {
      if (!answer || typeof answer !== 'object') continue
      const record = answer as { type?: number, data?: string }
      if (record.type !== type || typeof record.data !== 'string') continue
      if (type === 1 && parseV4(record.data)) return record.data
      if (type === 28 && V6.test(record.data)) return record.data
    }
    return null
  })
}

function geolocate(ip: string): Promise<GeoPlace | null> {
  return cached(geoCache, geoInflight, ip.toLowerCase(), async () => {
    const fromIpwho = await geolocateIpwho(ip)
    if (fromIpwho) return fromIpwho
    return geolocateGeojs(ip)
  })
}

async function geolocateIpwho(ip: string): Promise<GeoPlace | null> {
  if (!V4.test(ip) && !V6.test(ip)) return null
  const body = await fetchJson(`https://ipwho.is/${ip}`)
  if (!body || body.success === false) return null
  return placeFrom(body.latitude, body.longitude, body.city, body.region, body.country)
}

async function geolocateGeojs(ip: string): Promise<GeoPlace | null> {
  if (!V4.test(ip) && !V6.test(ip)) return null
  const body = await fetchJson(`https://get.geojs.io/v1/ip/geo/${ip}.json`)
  if (!body) return null
  return placeFrom(body.latitude, body.longitude, body.city, body.region, body.country)
}

function placeFrom(lat: unknown, lng: unknown, city: unknown, region: unknown, country: unknown): GeoPlace | null {
  const latitude = typeof lat === 'number' ? lat : Number(lat)
  const longitude = typeof lng === 'number' ? lng : Number(lng)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return {
    lat: latitude,
    lng: longitude,
    city: typeof city === 'string' ? city : '',
    region: typeof region === 'string' ? region : '',
    country: typeof country === 'string' ? country : '',
  }
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(url, { headers, signal: controller.signal })
    if (!resp.ok) return null
    const body: unknown = await resp.json()
    if (!body || typeof body !== 'object') return null
    return body as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function cached<T>(
  cache: Map<string, T>,
  inflight: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (cache.has(key)) return Promise.resolve(cache.get(key) as T)
  const pending = inflight.get(key)
  if (pending) return pending
  const job = load().then(value => {
    cache.set(key, value)
    inflight.delete(key)
    return value
  }, err => {
    inflight.delete(key)
    throw err
  })
  inflight.set(key, job)
  return job
}

function parseV4(ip: string): number[] | null {
  if (!V4.test(ip)) return null
  const parts = ip.split('.').map(part => Number(part))
  if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return parts
}

function isPrivateIp(ip: string): boolean {
  return parseV4(ip) ? isPrivateV4(ip) : isPrivateV6(ip)
}

function isPrivateV4(ip: string): boolean {
  const parts = parseV4(ip)
  if (!parts) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateV6(ip: string): boolean {
  const raw = ip.toLowerCase().split('%')[0]
  if (raw === '::' || raw === '::1') return true
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isPrivateV4(mapped[1])
  const head = raw.split(':')[0]
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) return true
  if (head.startsWith('fc') || head.startsWith('fd')) return true
  return false
}

function isLocalName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  return name === 'localhost' || name.endsWith('.local') || name.endsWith('.localhost')
}
