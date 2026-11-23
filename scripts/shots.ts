// `npm run shots`: walks the whole path in the Even Hub simulator and writes one PNG per screen into docs/screens/.
// Dev server on 127.0.0.1:5173 + the simulator through tools/sim.sh (automation API on 127.0.0.1:9898).
// Each PNG is flattened on black (plain RGB: the simulator's RGBA keeps the picture in the alpha channel).
// Checks each PNG is 576×288, runs the measured line-width check on the page the app actually drew,
// stops the simulator and the server, and exits 0 only if everything passed. Local only: no other network call.
// Backend mode (BRIEF-D3.md § 4.5): a second dev server built with VITE_DATA_SOURCE=backend talks to the in-memory stub
// of test/stub-backend.ts served on 127.0.0.1:8788 (the contract of BRIEF-D3.md § 3; no Worker, nothing upstream).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkPage, SCREEN_H, SCREEN_W } from '../src/logic/measure.ts'
import { flattenOnBlack, pngInfo } from './png.ts'
import type { Dataset, PageSpec } from '../src/logic/types.ts'
import { stubBackend } from '../test/stub-backend.ts'
import { buildItems, eventsOf } from '../src/logic/items.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIM = join(APP, 'tools', 'sim.sh')
const OUT = join(APP, 'docs', 'screens')
const DEV = 'http://127.0.0.1:5173'
const DEV_BACKEND = 'http://127.0.0.1:5174'
const STUB_PORT = 8788
const STUB = `http://127.0.0.1:${STUB_PORT}`
const API = 'http://127.0.0.1:9898'

// ---- the stub backend for the backend-mode runs ----
const ds = JSON.parse(readFileSync(join(APP, 'src', 'data', 'dataset.json'), 'utf8')) as Dataset
const supplier = eventsOf(ds).find((e) => e.brief)
if (!supplier) throw new Error('the dataset has no event with a brief')
const be = stubBackend(buildItems(ds, ['mail'], STATIC_ALTS), { demoCalendar: { now: '13:52', events: [supplier] } })
const extra = { signinNeeded: false } // shots only: every items call answers 403 signin_needed (the live F path)

function serveStub(): Promise<Server> {
  const server = createServer((req, res) => {
    if (be.state.down) return void req.socket.destroy() // « No connection »
    const cors = {
      'access-control-allow-origin': DEV_BACKEND,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST',
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end()
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', async () => {
      const headers: Record<string, string> = {}
      if (req.headers.authorization) headers.authorization = req.headers.authorization
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
      let r: { status: number; json(): Promise<unknown> }
      if (extra.signinNeeded && req.url === '/api/items') r = { status: 403, json: async () => ({ error: 'signin_needed' }) }
      else r = await be.fetch(`${STUB}${req.url}`, { method: req.method ?? 'GET', headers, body: body === '' ? undefined : body })
      res.writeHead(r.status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(await r.json()))
    })
  })
  return new Promise((ok, ko) => {
    server.once('error', ko)
    server.listen(STUB_PORT, '127.0.0.1', () => ok(server))
  })
}

type Action = 'click' | 'up' | 'down' | 'double_click'
interface Step {
  input?: Action
  expect?: string // the page the app must draw after the input ('' = no new page expected)
  contains?: string // a text the drawn page must contain
  shot?: string
  settle?: number // ms to wait before the next step when no page is expected (firmware cursor moves)
  raw?: boolean // a screen the app does not draw (the system exit dialog): screenshot only, no page check
  absent?: string // a text the drawn page must NOT contain
  before?: () => void // backend runs: change the stub before this step
  through?: boolean // other pages (Working…) may come first: wait for `expect`
}
interface Run {
  query: string
  backend?: boolean // the dev server built with VITE_DATA_SOURCE=backend, against the stub
  setup?: () => void
  allowConsole?: RegExp // backend runs: the simulator's own log line of a failure the run provokes on purpose
  steps: Step[]
}
let allowConsole: RegExp | undefined
const isError = (e: ConsoleEntry) =>
  (e.level === 'error' || e.message.startsWith('[uncaught]') || e.message.startsWith('[unhandledrejection]')) &&
  !(allowConsole && allowConsole.test(e.message))

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
      { input: 'click', expect: 'C', contains: 'To: Sam · Telegram, Crew group', shot: '17-C-telegram-confirm.png' },
      { input: 'down', settle: 600 },
      { input: 'click', expect: 'SENT', contains: 'Sent on Telegram √', shot: '18-sent-telegram.png' },
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
      { input: 'down', expect: 'F', contains: 'Too many tries', shot: '20-F-later.png' },
      { input: 'down', expect: 'F', contains: "Today's demo limit", shot: '21-F-limit.png' },
    ],
  },
  {
    query: '?sources=mail',
    steps: [
      { expect: 'A', contains: '2 need you' },
      // simulator 0.9.5 draws no exit dialog: after shutDownPageContainer(1) the glasses canvas goes black (seen 2026-11-23)
      { input: 'double_click', settle: 1500, raw: true, shot: '19-double-press-sim.png' },
    ],
  },
  // ---- backend mode (BRIEF-D3.md § 4.2, 4.3, 4.1a) ----
  {
    query: '',
    backend: true,
    setup: () => Object.assign(be.state, { down: false, calendarError: false }),
    steps: [
      // GET /api/calendar answers now 13:52 and the 14:00 event with its brief → E opens by itself
      { expect: 'E', contains: '14:00 · Supplier call', shot: '22-E-brief-backend.png', through: true },
      { input: 'click', expect: 'A', contains: '2 need you · 13:52 · next 14:00 Supplier call', shot: '23-A-home-backend.png' },
    ],
  },
  {
    query: '',
    backend: true,
    setup: () => Object.assign(be.state, { down: false, calendarError: true }),
    allowConsole: /^\[fetch\] 500 Internal Server Error http:\/\/127\.0\.0\.1:8788\/api\/calendar$/,
    steps: [{ expect: 'A', contains: '2 need you', absent: 'next', shot: '24-A-home-no-calendar.png', through: true }],
  },
  {
    query: '',
    backend: true,
    setup: () => {
      Object.assign(be.state, { down: false, calendarError: false })
      extra.signinNeeded = true
    },
    allowConsole: /^\[fetch\] 403 Forbidden http:\/\/127\.0\.0\.1:8788\/api\/items$/,
    steps: [{ expect: 'F', contains: 'Sign-in needed — open brief.appfinishers.com', shot: '25-F-signin-backend.png', through: true }],
  },
  {
    query: '',
    backend: true,
    setup: () => {
      extra.signinNeeded = false
      Object.assign(be.state, { down: true, calendarError: false })
    },
    allowConsole: /^\[fetch\].*http:\/\/127\.0\.0\.1:8788\/api\/session\b/,
    steps: [
      { expect: 'F', contains: 'No connection', shot: '26-F-offline-backend.png', through: true },
      // the stub comes back; NO input: the app retries by itself (2 s, 5 s, 15 s, then every 30 s)
      { before: () => (be.state.down = false), expect: 'E', contains: '14:00 · Supplier call', shot: '27-E-after-retry.png', through: true },
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
async function waitPage(screen: string, timeoutMs = 15_000, through = false): Promise<{ ok: boolean; spec: PageSpec }> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    seen.push(...(await newEntries()))
    while (seen.length) {
      const e = seen.shift() as ConsoleEntry
      const i = e.message.indexOf('BRIEF_PAGE ')
      if (isError(e))
        throw new Error(`app console: ${e.message}`)
      if (i < 0) continue
      const page = JSON.parse(e.message.slice(i + 'BRIEF_PAGE '.length)) as { ok: boolean; spec: PageSpec }
      if (page.spec.screen === screen && (!through || !JSON.stringify(page.spec).includes('Working…'))) return page
      if (through) continue
      throw new Error(`expected page ${screen}, the app drew ${page.spec.screen}`)
    }
    await sleep(200)
  }
  throw new Error(`timeout waiting for page ${screen}`)
}

/** Screenshot → flattened RGB PNG on disk; returns the problems (size, colour type). */
async function shoot(file: string): Promise<{ size: string; problems: string[] }> {
  const r = await get(`${API}/api/screenshot/glasses`, 10_000)
  const flat = flattenOnBlack(Buffer.from(await r.arrayBuffer()))
  const { w, h, colorType } = pngInfo(flat)
  const size = `${w}×${h}`
  const problems: string[] = []
  if (w !== SCREEN_W || h !== SCREEN_H) problems.push(`PNG is ${size}, not 576×288`)
  if (colorType !== 2) problems.push(`PNG colour type ${colorType}, not RGB`)
  writeFileSync(join(OUT, file), flat)
  return { size, problems }
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
  let viteBackend: ChildProcess | undefined
  let stub: Server | undefined
  mkdirSync(OUT, { recursive: true })
  for (const f of readdirSync(OUT)) if (f.endsWith('.png')) unlinkSync(join(OUT, f))

  try {
    // the port must be free and the simulator stopped before we start
    for (const u of [DEV, DEV_BACKEND, STUB]) {
      const busy = await get(u, 1000).then(
        () => true,
        () => false,
      )
      if (busy) throw new Error(`${u} is already in use: stop that server first`)
    }
    sim('stop')

    const startVite = async (base: string, env: Record<string, string>): Promise<ChildProcess> => {
      const port = new URL(base).port
      const child = spawn(join(APP, 'node_modules', '.bin', 'vite'), ['--host', '127.0.0.1', '--port', port, '--strictPort'], {
        cwd: APP,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let viteLog = ''
      child.stdout?.on('data', (d) => (viteLog += d))
      child.stderr?.on('data', (d) => (viteLog += d))
      await waitFor(`the dev server on ${base}`, async () => (await get(base, 1000)).ok, 30_000).catch((e) => {
        throw new Error(`${(e as Error).message}\n${viteLog}`)
      })
      console.log(`dev server up: ${base}`)
      return child
    }
    vite = await startVite(DEV, {})
    viteBackend = await startVite(DEV_BACKEND, { VITE_DATA_SOURCE: 'backend', VITE_API_BASE: STUB })
    stub = await serveStub()
    console.log(`stub backend up: ${STUB}`)

    for (const run of RUNS) {
      run.setup?.()
      allowConsole = run.allowConsole
      const url = `${run.backend ? DEV_BACKEND : DEV}/${run.query}`
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
        step.before?.()
        if (step.input) {
          const r = await fetch(`${API}/api/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: step.input }),
          })
          const j = (await r.json()) as { ok?: boolean }
          if (!j.ok) throw new Error(`input ${step.input} refused`)
        }
        if (step.raw && step.shot) {
          await sleep(step.settle ?? 500)
          const shot = await shoot(step.shot)
          if (shot.problems.length) failed++
          const result = shot.problems.length ? `FAIL: ${shot.problems.join('; ')}` : 'ok'
          rows.push({ shot: step.shot, screen: 'system', size: shot.size, lines: 0, widest: 0, result })
          continue
        }
        if (!step.expect) {
          await sleep(step.settle ?? 500)
          continue
        }
        const page = await waitPage(step.expect, step.through ? 20_000 : 15_000, step.through)
        await sleep(400) // let the frame paint
        const problems: string[] = []
        if (!page.ok) problems.push('the SDK refused the page')
        const blob = JSON.stringify(page.spec)
        if (step.contains && !blob.includes(JSON.stringify(step.contains).slice(1, -1)))
          problems.push(`page does not contain « ${step.contains} »`)
        if (step.absent && blob.includes(step.absent)) problems.push(`page contains « ${step.absent} »`)
        const report = checkPage(page.spec)
        problems.push(...report.problems)
        let size = '?'
        if (step.shot) {
          const shot = await shoot(step.shot)
          size = shot.size
          problems.push(...shot.problems)
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
        if (isError(e)) {
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
    for (const child of [vite, viteBackend])
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((r) => child.once('exit', r))
      }
    if (stub) await new Promise((r) => stub?.close(r))
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
