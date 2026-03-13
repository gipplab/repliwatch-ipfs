import type { CidRecord, ScanStats, AppState } from './types'
import { freshStats } from './types'
import { findProviders, findProvidersFast, OverloadError } from './routing'

type Listener = (state: AppState) => void

const POOL_MAX = 20
const POOL_MIN = 2
const POOL_INITIAL = 12
const BACKOFF_BASE_MS = 1500
const BACKOFF_MAX_MS = 20_000
const MAX_RETRIES = 3

export class Scanner {
  private state: AppState
  private listeners: Set<Listener> = new Set()
  private abortController: AbortController | null = null
  private poolSize = POOL_INITIAL
  private backoffMs = 0
  private consecutiveOverloads = 0
  private successesSinceLastOverload = 0
  private priorityQueue: CidRecord[] = []
  private useFastLookup = true

  constructor() {
    this.state = {
      cids: new Map(),
      scanState: 'idle',
      stats: freshStats(),
      filter: 'all',
      search: '',
      redListThreshold: 3,
    }
  }

  getState(): AppState {
    return this.state
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    for (const fn of this.listeners) fn(this.state)
  }

  async loadCids(url: string): Promise<void> {
    const resp = await fetch(url)
    const text = await resp.text()
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

    const cids = new Map<string, CidRecord>()
    for (const cid of lines) {
      cids.set(cid, { cid, providers: [], status: 'pending' })
    }

    this.state.cids = cids
    this.recomputeStats()
    this.notify()
  }

  clearCids() {
    this.stop()
    this.priorityQueue = []
    this.state.cids = new Map()
    this.recomputeStats()
    this.notify()
  }

  deleteCid(cid: string) {
    this.state.cids.delete(cid)
    this.priorityQueue = this.priorityQueue.filter(r => r.cid !== cid)
    this.recomputeStats()
    this.notify()
  }

  addCids(raw: string[]): number {
    const lines = raw.map(l => l.trim()).filter(Boolean)
    const newRecords: CidRecord[] = []

    for (const cid of lines) {
      if (this.state.cids.has(cid)) continue
      const rec: CidRecord = { cid, providers: [], status: 'pending' }
      newRecords.push(rec)
    }

    if (newRecords.length === 0) return 0

    const rebuilt = new Map<string, CidRecord>()
    for (const rec of newRecords) rebuilt.set(rec.cid, rec)
    for (const [k, v] of this.state.cids) rebuilt.set(k, v)
    this.state.cids = rebuilt

    if (this.state.scanState === 'running') {
      this.priorityQueue.push(...newRecords)
    }

    this.recomputeStats()
    this.notify()
    return newRecords.length
  }

  setFilter(filter: AppState['filter']) {
    this.state.filter = filter
    this.notify()
  }

  setSearch(search: string) {
    this.state.search = search
    this.notify()
  }

  setRedListThreshold(n: number) {
    this.state.redListThreshold = Math.max(1, n)
    this.recomputeStats()
    this.notify()
  }

  start() {
    if (this.state.scanState === 'running') return
    this.abortController = new AbortController()
    this.state.scanState = 'running'
    this.poolSize = POOL_INITIAL
    this.backoffMs = 0
    this.consecutiveOverloads = 0
    this.notify()
    this.runScan()
  }

  pause() {
    if (this.state.scanState !== 'running') return
    this.abortController?.abort()
    this.state.scanState = 'paused'
    this.notify()
  }

  resume() {
    if (this.state.scanState !== 'paused') return
    this.start()
  }

  stop() {
    this.abortController?.abort()
    this.state.scanState = 'idle'
    this.notify()
  }

  reset() {
    this.stop()
    for (const rec of this.state.cids.values()) {
      rec.providers = []
      rec.status = 'pending'
      rec.error = undefined
      rec.lastScanned = undefined
      rec.retries = 0
      rec.failedRouter = undefined
    }
    this.recomputeStats()
    this.notify()
  }

  getFilteredCids(): CidRecord[] {
    const { filter, search, cids, redListThreshold } = this.state
    let arr = [...cids.values()]

    if (filter === 'critical') {
      arr = arr.filter(r => r.status === 'done' && r.providers.length === 0)
    } else if (filter === 'warning') {
      arr = arr.filter(r => r.status === 'done' && r.providers.length > 0 && r.providers.length < redListThreshold)
    } else if (filter === 'healthy') {
      arr = arr.filter(r => r.status === 'done' && r.providers.length >= redListThreshold)
    } else if (filter === 'pending') {
      arr = arr.filter(r => r.status === 'pending' || r.status === 'scanning')
    } else if (filter === 'error') {
      arr = arr.filter(r => r.status === 'error')
    }

    if (search) {
      const q = search.toLowerCase()
      arr = arr.filter(r =>
        r.cid.toLowerCase().includes(q) ||
        r.providers.some(p => p.id.toLowerCase().includes(q)),
      )
    }

    return arr
  }

  getRedList(): CidRecord[] {
    const { cids, redListThreshold } = this.state
    return [...cids.values()].filter(
      r => r.status === 'done' && r.providers.length < redListThreshold,
    )
  }

  exportRedList(): string {
    return this.getRedList().map(r => r.cid).join('\n')
  }

  retryErrors() {
    const errored = [...this.state.cids.values()].filter(r => r.status === 'error')
    if (errored.length === 0) return

    for (const rec of errored) {
      rec.status = 'pending'
      rec.error = undefined
    }

    this.priorityQueue.unshift(...errored)
    this.recomputeStats()
    this.notify()

    if (this.state.scanState !== 'running') {
      this.start()
    }
  }

  private onSuccess() {
    this.consecutiveOverloads = 0
    this.successesSinceLastOverload++
    if (this.poolSize < POOL_MAX && this.successesSinceLastOverload % 5 === 0) {
      this.poolSize++
    }
    this.backoffMs = Math.max(0, this.backoffMs - 500)
  }

  private onOverload() {
    this.consecutiveOverloads++
    this.successesSinceLastOverload = 0
    this.poolSize = Math.max(POOL_MIN, Math.floor(this.poolSize * 0.5))
    this.backoffMs = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * Math.pow(2, this.consecutiveOverloads - 1),
    )
  }

  private async runScan(): Promise<void> {
    const signal = this.abortController!.signal

    const queue = [...this.state.cids.values()].filter(
      r => r.status === 'pending' || r.status === 'error',
    )

    this.useFastLookup = true
    await this.drainQueue(queue, signal)

    if (signal.aborted) return

    const retryable = [...this.state.cids.values()].filter(
      r => r.status === 'error' && (r.retries ?? 0) < MAX_RETRIES,
    )
    if (retryable.length > 0) {
      this.useFastLookup = false
      this.poolSize = Math.max(POOL_MIN, Math.floor(POOL_INITIAL / 2))
      this.backoffMs = 0
      this.consecutiveOverloads = 0
      await this.drainQueue(retryable, signal)
    }

    if (!signal.aborted) {
      this.state.scanState = 'done'
      this.notify()
    }
  }

  private drainQueue(queue: CidRecord[], signal: AbortSignal): Promise<void> {
    if (queue.length === 0 && this.priorityQueue.length === 0) return Promise.resolve()

    let cursor = 0
    let inFlight = 0
    let resolve: () => void
    const done = new Promise<void>(res => { resolve = res })

    const isQueueEmpty = () =>
      cursor >= queue.length && this.priorityQueue.length === 0

    const settleIfDone = () => {
      if (isQueueEmpty() && inFlight === 0) resolve()
    }

    const next = () => {
      while (inFlight < this.poolSize && !isQueueEmpty()) {
        if (signal.aborted) { settleIfDone(); return }

        const rec = this.priorityQueue.length > 0
          ? this.priorityQueue.shift()!
          : queue[cursor++]
        inFlight++

        const launch = () => {
          this.scanOne(rec, signal).finally(() => {
            inFlight--
            if (signal.aborted) { settleIfDone(); return }
            settleIfDone()
            if (!isQueueEmpty()) next()
          })
        }

        if (this.backoffMs > 0) setTimeout(launch, this.backoffMs)
        else launch()
      }

      settleIfDone()
    }

    next()
    return done
  }

  private async scanOne(rec: CidRecord, signal: AbortSignal): Promise<void> {
    rec.status = 'scanning'
    this.throttledNotify()

    try {
      rec.providers = this.useFastLookup
        ? await findProvidersFast(rec.cid, signal, undefined, rec.failedRouter)
        : await findProviders(rec.cid, signal)
      rec.status = 'done'
      rec.lastScanned = Date.now()
      rec.failedRouter = undefined
      this.onSuccess()
    } catch (err: unknown) {
      if (signal.aborted) {
        rec.status = 'pending'
        return
      }
      rec.status = 'error'
      rec.retries = (rec.retries ?? 0) + 1
      rec.error = err instanceof Error ? err.message : String(err)

      if (err instanceof OverloadError) {
        rec.failedRouter = err.router
        this.onOverload()
      }
    }

    this.recomputeStats()
    this.throttledNotify()
  }

  private notifyTimer: ReturnType<typeof setTimeout> | null = null

  private throttledNotify() {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.notify()
    }, 150)
  }

  private recomputeStats() {
    const stats = freshStats()
    stats.total = this.state.cids.size
    const threshold = this.state.redListThreshold

    for (const rec of this.state.cids.values()) {
      switch (rec.status) {
        case 'done': {
          stats.scanned++
          const n = rec.providers.length
          if (n === 0) stats.critical++
          else if (n < threshold) stats.warning++
          else stats.healthy++
          break
        }
        case 'error':
          stats.errors++
          stats.scanned++
          break
        case 'pending':
        case 'scanning':
          stats.pending++
          break
      }
    }

    this.state.stats = stats
  }
}
