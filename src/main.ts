import './style.css'
import { Scanner } from './scanner'
import { initUI } from './ui'

async function boot() {
  const scanner = new Scanner()
  initUI(scanner)
}

boot().catch(err => {
  console.error('Failed to boot RepliWatch:', err)
  document.getElementById('app')!.innerHTML = `
    <div style="padding:48px;text-align:center;color:#f85149">
      <h2>Failed to load</h2>
      <p>${err instanceof Error ? err.message : err}</p>
    </div>
  `
})
