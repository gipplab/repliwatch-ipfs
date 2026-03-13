export interface Provider {
  id: string
  addrs: string[]
  protocols: string[]
}

export interface CidRecord {
  cid: string
  providers: Provider[]
  status: 'pending' | 'scanning' | 'done' | 'error'
  error?: string
  lastScanned?: number
  retries?: number
  failedRouter?: string
}

export type RiskLevel = 'critical' | 'warning' | 'healthy' | 'unknown'

export interface ScanStats {
  total: number
  scanned: number
  errors: number
  critical: number
  warning: number
  healthy: number
  pending: number
}

export type ScanState = 'idle' | 'running' | 'paused' | 'done'

export interface AppState {
  cids: Map<string, CidRecord>
  scanState: ScanState
  stats: ScanStats
  filter: 'all' | 'critical' | 'warning' | 'healthy' | 'pending' | 'error'
  search: string
  redListThreshold: number
}

export function getRiskLevel(record: CidRecord, threshold: number): RiskLevel {
  if (record.status !== 'done') return 'unknown'
  const count = record.providers.length
  if (count === 0) return 'critical'
  if (count < threshold) return 'warning'
  return 'healthy'
}

export function freshStats(): ScanStats {
  return { total: 0, scanned: 0, errors: 0, critical: 0, warning: 0, healthy: 0, pending: 0 }
}
