import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { CircleMarker, Map as LeafletMap } from 'leaflet'
import type { CidRecord, Provider } from './types'
import { formatPlace, locateProvider, type ProviderLocation } from './geo'

const MAP_NOTE = 'Approximate, from advertised addresses'

let generation = 0
let overlay: HTMLElement | null = null
let map: LeafletMap | null = null
let onKey: ((event: KeyboardEvent) => void) | null = null

export function openProviderMap(rec: CidRecord) {
  closeProviderMap()
  const gen = generation
  const alive = () => generation === gen

  overlay = document.createElement('div')
  overlay.className = 'map-overlay'
  overlay.innerHTML = `
    <div class="map-panel" role="dialog" aria-modal="true" aria-label="Provider map">
      <div class="map-head">
        <div class="map-title">
          <span class="map-kicker">Provider map</span>
          <code class="map-cid" title="${esc(rec.cid)}">${esc(rec.cid)}</code>
        </div>
        <button type="button" class="btn btn-ghost map-close">Close</button>
      </div>
      <div class="map-body">
        <div class="map-stage">
          <div class="map-canvas"></div>
          <div class="map-empty" hidden>No public addresses to plot</div>
        </div>
        <div class="map-side">
          <ul class="map-list"></ul>
          <p class="map-note">${MAP_NOTE}</p>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  document.body.classList.add('map-open')

  const list = overlay.querySelector('.map-list') as HTMLElement
  const note = overlay.querySelector('.map-note') as HTMLElement
  const empty = overlay.querySelector('.map-empty') as HTMLElement
  const canvas = overlay.querySelector('.map-canvas') as HTMLElement

  overlay.querySelector('.map-close')!.addEventListener('click', () => closeProviderMap())
  overlay.addEventListener('click', event => {
    if (event.target === overlay) closeProviderMap()
  })
  onKey = event => {
    if (event.key === 'Escape') closeProviderMap()
  }
  document.addEventListener('keydown', onKey)

  map = L.map(canvas, {
    zoomControl: true,
    scrollWheelZoom: true,
    zoomSnap: 0,
    zoomDelta: 0.5,
  })
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 18,
  }).addTo(map)
  map.setView([20, 0], 2)

  const markers = new Map<number, CircleMarker>()
  const groups = new Map<string, PinGroup>()
  const rows = rec.providers.map((provider, index) => ({ provider, index }))

  list.innerHTML = rows.map(({ provider, index }) => `
    <li class="map-peer" data-index="${index}">
      <span class="map-peer-id" title="${esc(provider.id)}">${esc(truncate(provider.id, 22))}</span>
      <span class="map-peer-meta">locating…</span>
    </li>
  `).join('')

  list.addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest('.map-peer') as HTMLElement | null
    const index = Number(row?.dataset.index)
    if (!row || !Number.isInteger(index)) return
    const marker = markers.get(index)
    if (!marker || !map) return
    selectIndexes(list, [index])
    row.scrollIntoView({ block: 'nearest' })
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 4))
    marker.openPopup()
  })

  note.textContent = 'Locating…'

  void plot()

  async function plot() {
    await runPool(rows, 4, async ({ provider, index }) => {
      let location: ProviderLocation
      try {
        location = await locateProvider(provider.addrs)
      } catch {
        location = { ip: null, relay: false, place: null, status: 'unavailable' }
      }
      if (!alive()) return
      const row = list.querySelector(`[data-index="${index}"]`)
      const meta = row?.querySelector('.map-peer-meta')
      if (meta) meta.textContent = metaText(location)
      if (location.status === 'located' && location.place) {
        row?.classList.add('has-pin')
        markers.set(index, pinFor(location, provider, index))
      }
    }, () => !alive())

    if (!alive() || !map) return
    note.textContent = MAP_NOTE
    const current = map
    requestAnimationFrame(() => {
      if (!alive()) return
      focusMap(current, groups, empty)
    })
  }

  function pinFor(location: ProviderLocation, provider: Provider, index: number): CircleMarker {
    const place = location.place!
    const key = `${place.lat.toFixed(3)},${place.lng.toFixed(3)}`
    const existing = groups.get(key)
    const peer = { index, id: provider.id, relay: location.relay }
    if (existing) {
      existing.peers.push(peer)
      existing.marker.setPopupContent(popupHtml(existing.place, existing.peers))
      existing.marker.setRadius(8)
      return existing.marker
    }

    const marker = L.circleMarker([place.lat, place.lng], {
      radius: 6,
      color: '#111111',
      weight: 1,
      fillColor: location.relay ? '#ffffff' : '#cc2222',
      fillOpacity: 1,
    })
    const group: PinGroup = {
      marker,
      place: formatPlace(place),
      peers: [peer],
    }
    marker.bindPopup(popupHtml(group.place, group.peers))
    marker.on('click', () => {
      const indexes = group.peers.map(item => item.index)
      selectIndexes(list, indexes)
      list.querySelector(`[data-index="${indexes[0]}"]`)?.scrollIntoView({ block: 'nearest' })
    })
    marker.addTo(map!)
    groups.set(key, group)
    return marker
  }
}

export function closeProviderMap() {
  generation++
  if (onKey) document.removeEventListener('keydown', onKey)
  onKey = null
  map?.remove()
  map = null
  overlay?.remove()
  overlay = null
  document.body.classList.remove('map-open')
}

interface PinPeer {
  index: number
  id: string
  relay: boolean
}

interface PinGroup {
  marker: CircleMarker
  place: string
  peers: PinPeer[]
}

async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  stop: () => boolean,
) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!stop()) {
      const current = index++
      if (current >= items.length) return
      await fn(items[current])
    }
  })
  await Promise.all(workers)
}

function metaText(location: ProviderLocation): string {
  if (location.status === 'located' && location.place) {
    const where = formatPlace(location.place)
    const ip = location.ip ? ` · ${location.ip}` : ''
    const relay = location.relay ? ' · relay' : ''
    return `${where}${ip}${relay}`
  }
  if (location.status === 'private') return 'private address'
  if (location.status === 'none') return 'no public address'
  if (location.ip) return `${location.ip} · location unavailable`
  return 'location unavailable'
}

function popupHtml(place: string, peers: PinPeer[]): string {
  const lines = peers.map(peer =>
    `<div>${esc(truncate(peer.id, 22))}${peer.relay ? ' · relay' : ''}</div>`,
  ).join('')
  return `<div class="map-popup"><div class="map-popup-place">${esc(place)}</div>${lines}</div>`
}

function focusMap(map: LeafletMap, groups: Map<string, PinGroup>, empty: HTMLElement) {
  map.invalidateSize()
  const size = map.getSize()
  const cover = size.x > 0 && size.y > 0
    ? Math.log2(Math.max(size.x, size.y) / 256)
    : 1

  if (groups.size === 0) {
    empty.hidden = false
    map.setView([20, 0], cover)
    return
  }

  const points = [...groups.values()].map(group => group.marker.getLatLng())
  if (points.length === 1) {
    map.setView(points[0], 4)
    return
  }

  const bounds = L.latLngBounds(points)
  map.fitBounds(bounds, { padding: [24, 24], maxZoom: 5, animate: false })
  if (map.getZoom() < cover) map.setView(bounds.getCenter(), cover, { animate: false })
}

function selectIndexes(list: HTMLElement, indexes: number[]) {
  const selected = new Set(indexes)
  list.querySelectorAll('.map-peer').forEach(row => {
    const index = Number((row as HTMLElement).dataset.index)
    row.classList.toggle('active', selected.has(index))
  })
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) + '…' : value
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
