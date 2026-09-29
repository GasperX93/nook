import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const jobs = JSON.parse(readFileSync('jobs.json', 'utf8'))
const PORT = 9400 + Math.floor(Math.random() * 400)
const prof = mkdtempSync(join(tmpdir(), 'nook-icons-'))
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, '--hide-scrollbars', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 50 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl } catch {} ; if (!wsUrl) await sleep(200) }
const ws = new WebSocket(wsUrl); await new Promise(r => (ws.onopen = r))
let id = 0; const pending = new Map()
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Page.enable')
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
for (const j of jobs) {
  await send('Emulation.setDeviceMetricsOverride', { width: j.size, height: j.size, deviceScaleFactor: 1, mobile: false })
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${j.svg}</body></html>`
  await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') })
  await sleep(120)
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: j.size, height: j.size, scale: 1 } })
  writeFileSync(j.out, Buffer.from(r.result.data, 'base64'))
}
ws.close(); await new Promise(r => { chrome.once('exit', r); chrome.kill() }); try { rmSync(prof, { recursive: true, force: true }) } catch {}
console.log('rendered', jobs.length)
