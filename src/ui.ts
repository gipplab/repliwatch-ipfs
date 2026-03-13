import type { AppState, CidRecord, RiskLevel, ScanState, ScanStats } from './types'
import { getRiskLevel } from './types'
import type { Scanner } from './scanner'

const PAGE_SIZE = 100

let currentPage = readPageFromUrl()
let lastRenderedFilter = ''
let lastRenderedSearch = ''

function readPageFromUrl(): number {
  const p = new URLSearchParams(window.location.search).get('page')
  const n = p ? parseInt(p, 10) : NaN
  return Number.isFinite(n) && n >= 1 ? n - 1 : 0
}

function pushPageToUrl(page: number) {
  const url = new URL(window.location.href)
  if (page === 0) {
    url.searchParams.delete('page')
  } else {
    url.searchParams.set('page', String(page + 1))
  }
  history.replaceState(null, '', url)
}

function resetPage() {
  currentPage = 0
  pushPageToUrl(0)
}

function setPage(page: number, scanner: Scanner) {
  currentPage = page
  pushPageToUrl(page)
  render(scanner.getState(), scanner)
}

export function initUI(scanner: Scanner) {
  const app = document.getElementById('app')!
  app.innerHTML = buildShell()
  bindControls(scanner)

  window.addEventListener('popstate', () => {
    currentPage = readPageFromUrl()
    render(scanner.getState(), scanner)
  })

  scanner.subscribe(state => render(state, scanner))
  render(scanner.getState(), scanner)
}

function buildShell(): string {
  return `
    <header class="header">
      <div class="header-left">
        <h1 class="logo"><span class="logo-icon">◉</span> RepliWatch</h1>
        <span class="tagline">IPFS Replication Monitor</span>
      </div>
      <div class="header-right">
        <label class="threshold-label">
          Red list threshold
          <input type="number" id="threshold-input" min="1" max="100" value="3" class="threshold-input" />
        </label>
      </div>
    </header>

    <section class="stats-bar" id="stats-bar"></section>

    <section class="controls">
      <div class="controls-left">
        <button id="btn-start" class="btn btn-primary">Start Scan</button>
        <button id="btn-pause" class="btn btn-secondary" disabled>Pause</button>
        <button id="btn-reset" class="btn btn-ghost">Reset</button>
        <button id="btn-retry" class="btn btn-secondary">Retry Errors</button>
        <button id="btn-export" class="btn btn-accent">Export Red List</button>
      </div>
      <div class="controls-right">
        <div class="filter-group" id="filter-group">
          <button class="filter-btn active" data-filter="all">All</button>
          <button class="filter-btn" data-filter="critical">Critical</button>
          <button class="filter-btn" data-filter="warning">Warning</button>
          <button class="filter-btn" data-filter="healthy">Healthy</button>
          <button class="filter-btn" data-filter="pending">Pending</button>
          <button class="filter-btn" data-filter="error">Errors</button>
        </div>
        <input type="text" id="search-input" placeholder="Search CID or Peer ID…" class="search-input" />
      </div>
    </section>

    <section class="add-cids-section">
      <div class="add-cids-row">
        <input type="text" id="cid-input" placeholder="Paste a CID to add…" class="cid-input" />
        <button id="btn-add-cid" class="btn btn-secondary">Add</button>
        <span class="add-divider"></span>
        <label class="btn btn-ghost upload-label" for="file-upload">Upload CID List</label>
        <input type="file" id="file-upload" accept=".txt,.csv,.text,text/plain" class="file-input-hidden" />
        <span class="add-divider"></span>
        <button id="btn-clear-list" class="btn btn-ghost">Clear List</button>
        <button id="btn-load-example" class="btn btn-ghost">Load Example</button>
        <span class="add-feedback" id="add-feedback"></span>
      </div>
    </section>

    <section class="progress-section" id="progress-section">
      <div class="progress-bar-track">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
      <span class="progress-text" id="progress-text">0 / 0</span>
    </section>

    <section class="table-section">
      <div class="table-container">
        <table class="cid-table">
          <thead>
            <tr>
              <th class="col-status">Status</th>
              <th class="col-cid">CID</th>
              <th class="col-providers">Providers</th>
              <th class="col-peers">Peer IDs</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody id="table-body"></tbody>
        </table>
      </div>
      <div class="pagination" id="pagination"></div>
    </section>
  `
}

function bindControls(scanner: Scanner) {
  document.getElementById('btn-start')!.addEventListener('click', () => {
    const scanState = scanner.getState().scanState
    if (scanState === 'paused') scanner.resume()
    else scanner.start()
  })

  document.getElementById('btn-pause')!.addEventListener('click', () => {
    scanner.pause()
  })

  document.getElementById('btn-reset')!.addEventListener('click', () => {
    resetPage()
    scanner.reset()
  })

  document.getElementById('btn-retry')!.addEventListener('click', () => {
    scanner.retryErrors()
  })

  document.getElementById('btn-export')!.addEventListener('click', () => {
    const text = scanner.exportRedList()
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `repliwatch-redlist-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  })

  const filterGroup = document.getElementById('filter-group')!
  filterGroup.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('.filter-btn') as HTMLElement | null
    if (!btn) return
    const filter = btn.dataset.filter as AppState['filter']
    filterGroup.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    resetPage()
    scanner.setFilter(filter)
  })

  let searchDebounce: ReturnType<typeof setTimeout>
  document.getElementById('search-input')!.addEventListener('input', e => {
    clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      resetPage()
      scanner.setSearch((e.target as HTMLInputElement).value)
    }, 250)
  })

  const cidInput = document.getElementById('cid-input') as HTMLInputElement
  const addBtn = document.getElementById('btn-add-cid')!
  const fileUpload = document.getElementById('file-upload') as HTMLInputElement
  const feedback = document.getElementById('add-feedback')!

  function showFeedback(msg: string) {
    feedback.textContent = msg
    feedback.classList.add('visible')
    setTimeout(() => feedback.classList.remove('visible'), 3000)
  }

  addBtn.addEventListener('click', () => {
    const raw = cidInput.value.trim()
    if (!raw) return
    const lines = raw.split(/[\n,]+/)
    const added = scanner.addCids(lines)
    cidInput.value = ''
    showFeedback(added > 0 ? `+${added} CID${added > 1 ? 's' : ''} added` : 'Already in list')
  })

  cidInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') addBtn.click()
  })

  fileUpload.addEventListener('change', async () => {
    const file = fileUpload.files?.[0]
    if (!file) return
    const text = await file.text()
    const lines = text.split('\n')
    const added = scanner.addCids(lines)
    fileUpload.value = ''
    showFeedback(added > 0 ? `+${added} CID${added > 1 ? 's' : ''} imported` : 'No new CIDs')
  })

  document.getElementById('btn-clear-list')!.addEventListener('click', () => {
    resetPage()
    scanner.clearCids()
    showFeedback('List cleared')
  })

  document.getElementById('btn-load-example')!.addEventListener('click', async () => {
    resetPage()
    await scanner.loadCids('./cids.txt')
    showFeedback(`${scanner.getState().stats.total.toLocaleString()} CIDs loaded`)
  })

  document.getElementById('threshold-input')!.addEventListener('change', e => {
    const val = parseInt((e.target as HTMLInputElement).value, 10)
    if (!isNaN(val)) scanner.setRedListThreshold(val)
  })

  let deleteConfirmed = false

  document.getElementById('table-body')!.addEventListener('click', e => {
    const target = e.target as HTMLElement
    const deleteBtn = target.closest('.btn-delete') as HTMLElement | null
    if (deleteBtn) {
      const cid = deleteBtn.dataset.cid
      if (!cid) return
      if (!deleteConfirmed) {
        if (!confirm('This will permanently remove the CID from the list. Continue?')) return
        deleteConfirmed = true
      }
      scanner.deleteCid(cid)
      return
    }
    const cidEl = target.closest('.cid-code') as HTMLElement | null
    const peerEl = target.closest('.peer-chip') as HTMLElement | null
    if (cidEl) {
      copyToClipboard(cidEl.title || cidEl.textContent || '')
      flashCopied(cidEl)
    } else if (peerEl) {
      copyToClipboard(peerEl.dataset.peerid || peerEl.textContent || '')
      flashCopied(peerEl)
    }
  })

  document.getElementById('pagination')!.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('[data-page]') as HTMLElement | null
    if (!btn) return
    setPage(parseInt(btn.dataset.page!, 10), scanner)
  })
}

function render(state: AppState, scanner: Scanner) {
  renderStats(state.stats, state.redListThreshold)
  renderProgress(state.stats)
  renderButtons(state.scanState)

  if (state.filter !== lastRenderedFilter || state.search !== lastRenderedSearch) {
    resetPage()
    lastRenderedFilter = state.filter
    lastRenderedSearch = state.search
  }

  const filtered = scanner.getFilteredCids()
  renderTable(filtered, state.redListThreshold)
  renderPagination(filtered.length, scanner)
}

function renderStats(stats: ScanStats, threshold: number) {
  const el = document.getElementById('stats-bar')!
  const redCount = stats.critical + stats.warning
  el.innerHTML = `
    <div class="stat-card">
      <span class="stat-value">${stats.total.toLocaleString()}</span>
      <span class="stat-label">Total CIDs</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">${stats.scanned.toLocaleString()}</span>
      <span class="stat-label">Scanned</span>
    </div>
    <div class="stat-card stat-critical">
      <span class="stat-value">${stats.critical.toLocaleString()}</span>
      <span class="stat-label">No Providers</span>
    </div>
    <div class="stat-card stat-warning">
      <span class="stat-value">${stats.warning.toLocaleString()}</span>
      <span class="stat-label">&lt; ${threshold} Providers</span>
    </div>
    <div class="stat-card stat-healthy">
      <span class="stat-value">${stats.healthy.toLocaleString()}</span>
      <span class="stat-label">≥ ${threshold} Providers</span>
    </div>
    <div class="stat-card stat-redlist">
      <span class="stat-value">${redCount.toLocaleString()}</span>
      <span class="stat-label">Red List</span>
    </div>
    <div class="stat-card stat-error">
      <span class="stat-value">${stats.errors.toLocaleString()}</span>
      <span class="stat-label">Errors</span>
    </div>
  `
}

function renderProgress(stats: ScanStats) {
  const pct = stats.total > 0 ? ((stats.scanned + stats.errors) / stats.total) * 100 : 0
  const fill = document.getElementById('progress-fill') as HTMLElement
  const text = document.getElementById('progress-text') as HTMLElement
  fill.style.width = `${pct}%`
  text.textContent = `${(stats.scanned + stats.errors).toLocaleString()} / ${stats.total.toLocaleString()} (${pct.toFixed(1)}%)`
}

function renderButtons(scanState: ScanState) {
  const startBtn = document.getElementById('btn-start') as HTMLButtonElement
  const pauseBtn = document.getElementById('btn-pause') as HTMLButtonElement

  switch (scanState) {
    case 'running':
      startBtn.disabled = true
      startBtn.textContent = 'Scanning…'
      pauseBtn.disabled = false
      break
    case 'paused':
      startBtn.disabled = false
      startBtn.textContent = 'Resume'
      pauseBtn.disabled = true
      break
    case 'done':
      startBtn.disabled = true
      startBtn.textContent = 'Done'
      pauseBtn.disabled = true
      break
    default:
      startBtn.disabled = false
      startBtn.textContent = 'Start Scan'
      pauseBtn.disabled = true
  }
}

function renderPeers(rec: CidRecord): string {
  if (rec.providers.length > 0) {
    return rec.providers.map(p =>
      `<span class="peer-chip" data-peerid="${p.id}" title="${p.id}&#10;${p.addrs.join(', ') || 'no addrs'}">${truncate(p.id, 16)}</span>`
    ).join('')
  }
  if (rec.status === 'done') return '<span class="no-providers">None found</span>'
  if (rec.status === 'error') return `<span class="error-text" title="${esc(rec.error ?? '')}">${esc(rec.error ?? 'Error')}</span>`
  return '<span class="pending-text">—</span>'
}

function renderTable(records: CidRecord[], threshold: number) {
  const tbody = document.getElementById('table-body')!
  const start = currentPage * PAGE_SIZE
  const slice = records.slice(start, start + PAGE_SIZE)

  const rows = slice.map(rec => {
    const risk = getRiskLevel(rec, threshold)
    return `<tr class="row-${risk}">
      <td class="col-status">${statusBadge(rec, risk)}</td>
      <td class="col-cid"><code class="cid-code">${rec.cid}</code></td>
      <td class="col-providers"><span class="provider-count provider-${risk}">${rec.status === 'done' ? rec.providers.length : '—'}</span></td>
      <td class="col-peers">${renderPeers(rec)}</td>
      <td class="col-actions"><button class="btn-delete" data-cid="${rec.cid}" title="Remove CID">delete</button></td>
    </tr>`
  })

  tbody.innerHTML = rows.join('')
}

function findScanPage(scanner: Scanner): number | null {
  const filtered = scanner.getFilteredCids()
  for (let i = 0; i < filtered.length; i++) {
    if (filtered[i].status === 'scanning') {
      return Math.floor(i / PAGE_SIZE)
    }
  }
  return null
}

function renderPagination(total: number, scanner: Scanner) {
  const el = document.getElementById('pagination')!
  const pages = Math.ceil(total / PAGE_SIZE)
  if (pages <= 1) { el.innerHTML = ''; return }

  const scanPage = findScanPage(scanner)

  const maxVisible = 9
  let startPage = Math.max(0, currentPage - Math.floor(maxVisible / 2))
  let endPage = Math.min(pages, startPage + maxVisible)
  if (endPage - startPage < maxVisible) startPage = Math.max(0, endPage - maxVisible)

  let html = ''

  html += `<button class="page-btn page-nav" data-page="0" ${currentPage === 0 ? 'disabled' : ''} title="First page">«</button>`
  html += `<button class="page-btn page-nav" data-page="${currentPage - 1}" ${currentPage === 0 ? 'disabled' : ''} title="Previous page">‹</button>`

  for (let i = startPage; i < endPage; i++) {
    const cls = ['page-btn']
    if (i === currentPage) cls.push('active')
    if (i === scanPage) cls.push('scan-page')
    html += `<button class="${cls.join(' ')}" data-page="${i}">${i + 1}</button>`
  }

  html += `<button class="page-btn page-nav" data-page="${currentPage + 1}" ${currentPage >= pages - 1 ? 'disabled' : ''} title="Next page">›</button>`
  html += `<button class="page-btn page-nav" data-page="${pages - 1}" ${currentPage >= pages - 1 ? 'disabled' : ''} title="Last page">»</button>`

  if (scanPage !== null) {
    html += `<button class="page-btn page-nav-scan" data-page="${scanPage}" title="Jump to scan front (page ${scanPage + 1})">⇥ Scan p.${scanPage + 1}</button>`
  }

  html += `<span class="page-info">p.${currentPage + 1}/${pages} · ${total.toLocaleString()} items</span>`
  el.innerHTML = html
}

function statusBadge(rec: CidRecord, risk: RiskLevel): string {
  if (rec.status === 'scanning') return '<span class="badge badge-scanning">[..]</span>'
  if (rec.status === 'pending') return '<span class="badge badge-pending">[ ]</span>'
  if (rec.status === 'error') return '<span class="badge badge-error">[!]</span>'
  if (risk === 'critical') return '<span class="badge badge-critical">[x]</span>'
  if (risk === 'warning') return '<span class="badge badge-warning">[~]</span>'
  return '<span class="badge badge-healthy">[+]</span>'
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  })
}

function flashCopied(el: HTMLElement) {
  el.classList.add('copied')
  const tip = document.createElement('span')
  tip.className = 'copy-toast'
  tip.textContent = 'copied'
  el.appendChild(tip)
  setTimeout(() => {
    el.classList.remove('copied')
    tip.remove()
  }, 900)
}
