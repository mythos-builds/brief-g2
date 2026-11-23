// `npm run shots`: walks the whole path in the Even Hub simulator and writes one PNG per screen into docs/screens/.
// Dev server on 127.0.0.1:5173 + the simulator through ../tools/sim.sh (automation API on 127.0.0.1:9898).
// Checks each PNG is 576×288, runs the measured line-width check on the page the app actually drew,
// stops the simulator and the server, and exits 0 only if everything passed. Local only: no other network call.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkPage, SCREEN_H, SCREEN_W } from '../src/logic/measure.ts'
import type { PageSpec } from '../src/logic/types.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIM = join(APP, '..', 'tools', 'sim.sh')
const OUT = join(APP, 'docs', 'screens')
const DEV = 'http://127.0.0.1:5173'
const API = 'http://127.0.0.1:9898'

type Action = 'click' | 'up' | 'down' | 'double_click'
interface Step {
  input?: Action
  expect?: string // the page the app must draw after the input ('' = no new page expected)
  contains?: string // a text the drawn page must contain
  shot?: string
  settle?: number // ms to wait before the next step when no page is expected (firmware cursor moves)
}
interface Run {
  query: string
  steps: Step[]
}

const RUNS: Run[] = [
  {
    query: '?sources=mail',
    steps: [
      { expect: 'A', contains: '2 need you', shot: '01-A-home.png' },
      { input: 'click', expect: 'B', contains: 'From Marco', shot: '02-B-mail.png' },
      { input: 'down', settle: 600 },
      { input: 'click', expect: 'D2', contains: "No, I can't this Friday. Sorry.", shot: '03-D2-other-answers.png' },
      { input: 'down', settle: 600 },
      { input: 'click', expect: 'B', contains: "Draft: No, I can't this Friday. Sorry.", shot: '04-B-picked-answer.png' },
      { input: 'click', expect: 'C', contains: 'To: Marco Bellini', shot: '05-C-confirm.png' },
      { input: 'down', settle: 600 },
      { input: 'click', expect: 'SENT', contains: 'Sent √', shot: '06-sent.png' },
      { expect: 'B', contains: 'From Priya', shot: '07-B-next-mail.png' }, // after the 2 s of `Sent ✓`
    ],
  },
  {
    query: '?sources=mail,telegram',
    steps: [
      { expect: 'A', contains: '3 need you · 2 mail · 1 TG', shot: '08-A-home-telegram.png' },
      { input: 'click', expect: 'B', contains: 'TG · Sam (Crew group)', shot: '09-B-telegram.png' },
    ],
  },
  {
    query: '?sources=mail&at=13:50',
    steps: [
      { expect: 'E', contains: '14:00 · Supplier call', shot: '10-E-brief.png' },
      { input: 'down', expect: 'E', contains: '• corrugator down', shot: '11-E-brief-page2.png' },
      { input: 'click', expect: 'A', contains: 'need you', shot: '12-A-after-brief.png' },
    ],
  },
  {
    query: '?states=1',
    steps: [
      { expect: 'F', contains: 'Sign-in needed', shot: '13-F-signin.png' },
      { input: 'down', expect: 'F', contains: 'No connection', shot: '14-F-offline.png' },
      { input: 'down', expect: 'F', contains: 'Working', shot: '15-F-working.png' },
      { input: 'down', expect: 'F', contains: "Couldn't load", shot: '16-F-error.png' },
    ],
  },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function get(url: string, timeoutMs = 5000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
}

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      if (await fn()) return
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`)
}

function sim(...args: string[]): string {
  return execFileSync(SIM, args, { encoding: 'utf8', timeout: 90_000 }).trim()
}

interface ConsoleEntry {
  id: number
  level: string
  message: string
}
let lastId = -1

async function newEntries(): Promise<ConsoleEntry[]> {
  const url = lastId >= 0 ? `${API}/api/console?since_id=${lastId}` : `${API}/api/console`
  const r = await get(url)
  const j = (await r.json()) as { entries: ConsoleEntry[] }
  for (const e of j.entries) lastId = Math.max(lastId, e.id)
  return j.entries
}

const seen: ConsoleEntry[] = []
async function waitPage(screen: string, timeoutMs = 15_000): Promise<{ ok: boolean; spec: PageSpec }> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    seen.push(...(await newEntries()))
    while (seen.length) {
      const e = seen.shift() as ConsoleEntry
      const i = e.message.indexOf('BRIEF_PAGE ')
      if (e.level === 'error' || e.message.startsWith('[uncaught]') || e.message.startsWith('[unhandledrejection]'))
        throw new Error(`app console: ${e.message}`)
      if (i < 0) continue
      const page = JSON.parse(e.message.slice(i + 'BRIEF_PAGE '.length)) as { ok: boolean; spec: PageSpec }
      if (page.spec.screen === screen) return page
      throw new Error(`expected page ${screen}, the app drew ${page.spec.screen}`)
    }
    await sleep(200)
  }
  throw new Error(`timeout waiting for page ${screen}`)
}

function pngSize(buf: Buffer): { w: number; h: number } {
  const sig = buf.subarray(0, 8).toString('hex')
  if (sig !== '89504e470d0a1a0a' || buf.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('not a PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

interface Row {
  shot: string
  screen: string
  size: string
  lines: number
  widest: number
  result: string
}

async function main(): Promise<number> {
  const rows: Row[] = []
  let failed = 0
  let vite: ChildProcess | undefined
  mkdirSync(OUT, { recursive: true })
  for (const f of readdirSync(OUT)) if (f.endsWith('.png')) unlinkSync(join(OUT, f))

  try {
    // the port must be free and the simulator stopped before we start
    const busy = await get(DEV, 1000).then(
      () => true,
      () => false,
    )
    if (busy) throw new Error('port 5173 is already in use: stop that server first')
    sim('stop')

    vite = spawn(join(APP, 'node_modules', '.bin', 'vite'), ['--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
      cwd: APP,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let viteLog = ''
    vite.stdout?.on('data', (d) => (viteLog += d))
    vite.stderr?.on('data', (d) => (viteLog += d))
    await waitFor('the dev server on 127.0.0.1:5173', async () => (await get(DEV, 1000)).ok, 30_000).catch((e) => {
      throw new Error(`${(e as Error).message}\n${viteLog}`)
    })
    console.log(`dev server up: ${DEV}`)

    for (const run of RUNS) {
      const url = `${DEV}/${run.query}`
      console.log(`simulator → ${url}`)
      const pong = sim('start', url)
      if (!pong.includes('pong')) throw new Error(`simulator did not answer ping: ${pong}`)
      lastId = -1
      seen.length = 0
      await waitFor(
        'BRIEF_READY',
        async () => {
          const r = await get(`${API}/api/console`)
          const j = (await r.json()) as { entries: ConsoleEntry[] }
          return j.entries.some((e) => e.message.includes('BRIEF_READY'))
        },
        45_000,
      )

      for (const step of run.steps) {
        if (step.input) {
          const r = await fetch(`${API}/api/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: step.input }),
          })
          const j = (await r.json()) as { ok?: boolean }
          if (!j.ok) throw new Error(`input ${step.input} refused`)
        }
        if (!step.expect) {
          await sleep(step.settle ?? 500)
          continue
        }
        const page = await waitPage(step.expect)
        await sleep(400) // let the frame paint
        const problems: string[] = []
        if (!page.ok) problems.push('the SDK refused the page')
        const blob = JSON.stringify(page.spec)
        if (step.contains && !blob.includes(JSON.stringify(step.contains).slice(1, -1)))
          problems.push(`page does not contain « ${step.contains} »`)
        const report = checkPage(page.spec)
        problems.push(...report.problems)
        let size = '?'
        if (step.shot) {
          const r = await get(`${API}/api/screenshot/glasses`, 10_000)
          const buf = Buffer.from(await r.arrayBuffer())
          const { w, h } = pngSize(buf)
          size = `${w}×${h}`
          if (w !== SCREEN_W || h !== SCREEN_H) problems.push(`PNG is ${size}, not 576×288`)
          writeFileSync(join(OUT, step.shot), buf)
        }
        if (problems.length) failed++
        rows.push({
          shot: step.shot ?? '-',
          screen: page.spec.screen,
          size,
          lines: report.textLines,
          widest: report.widestLine,
          result: problems.length ? `FAIL: ${problems.join('; ')}` : 'ok',
        })
      }
      // nothing in the app console may be an error
      for (const e of await newEntries())
        if (e.level === 'error' || e.message.startsWith('[uncaught]') || e.message.startsWith('[unhandledrejection]')) {
          failed++
          rows.push({ shot: '-', screen: '-', size: '-', lines: 0, widest: 0, result: `FAIL console: ${e.message}` })
        }
      sim('stop')
    }
  } catch (e) {
    failed++
    rows.push({ shot: '-', screen: '-', size: '-', lines: 0, widest: 0, result: `FAIL: ${(e as Error).message}` })
  } finally {
    try {
      sim('stop')
    } catch (e) {
      failed++
      console.error(`sim.sh stop failed: ${(e as Error).message}`)
    }
    if (vite && vite.exitCode === null) {
      vite.kill('SIGTERM')
      await new Promise((r) => vite?.once('exit', r))
    }
  }

  console.log('\nshot                        screen  png      text-lines  widest-px  result')
  for (const r of rows)
    console.log(`${r.shot.padEnd(28)}${r.screen.padEnd(8)}${r.size.padEnd(9)}${String(r.lines).padEnd(12)}${String(r.widest).padEnd(11)}${r.result}`)
  const expected = RUNS.flatMap((r) => r.steps).filter((s) => s.shot).length
  const got = rows.filter((r) => r.shot !== '-' && r.result === 'ok').length
  console.log(`\n${got}/${expected} screens ok · ${failed} failure(s) · simulator: ${sim('status').split('\n')[0] || 'stopped'}`)
  return failed === 0 && got === expected ? 0 : 1
}

process.exit(await main())
