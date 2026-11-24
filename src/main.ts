// Glue: SDK bridge ⇄ the pure state machine ⇄ the data (static demo data, or the Brief Worker in backend mode).
// Static mode (default): nothing is fetched, nothing is sent. Backend mode (VITE_DATA_SOURCE=backend): BRIEF-D2.md § 3,
// BRIEF-D3.md § 3 and BRIEF-D4.md § 3 (items, calendar, `signin_needed`, the send outcomes, logout). The app only posts
// the index of the reply shown; whether a real mail leaves is the Worker's decision (`"real":true|false` in its answer).
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import './page.css'
import dataset from './data/dataset.json'
import { STATIC_ALTS } from './data/static-alts.ts'
import { API_BASE, CONNECT_ADDRESS, DATA_SOURCE, readConfig, REQUIRE_PAIRING, URL_SWITCHES } from './config.ts'
import { BackendError, bridgeStorage, createClient, type Client } from './data/backend.ts'
import { buildItems, clockOf, localClock } from './logic/items.ts'
import { afterSendFailure, afterSkipFailure, initialState, reduce } from './logic/flow.ts'
import { sideSignal, toInput } from './logic/input.ts'
import { createRetry } from './logic/retry.ts'
import { briefPages, pageFor, type PageContext } from './logic/pages.ts'
import type { AppState, Dataset, Input, Item, PageSpec, Screen, StateName } from './logic/types.ts'

const ds = dataset as Dataset
const cfg = readConfig(URL_SWITCHES ? location.search : '')
const backend = DATA_SOURCE === 'backend'
// backend mode: the clock and the events come from `GET /api/calendar` (load); until then, and when it fails, none
const ctx: PageContext = backend
  ? { ds, clock: '', sources: cfg.sources, calendar: [] }
  : { ds, clock: cfg.clock ?? clockOf(ds.now), sources: cfg.sources }
let state: AppState = firstState()
let page: PageSpec | undefined
let drawnAt = 0 // performance.now() when `page` was drawn: an unnamed list press needs it up ≥ 300 ms (input.ts)
let started = false
let drawing = false
let queue: Promise<void> = Promise.resolve()
let sentTimer: ReturnType<typeof setTimeout> | undefined
let client: Client | undefined

function stateScreen(which: StateName): Screen {
  return { kind: 'state', which }
}

function firstState(): AppState {
  if (backend) return { items: [], sent: [], screen: stateScreen('working') }
  if (REQUIRE_PAIRING) return { items: [], sent: [], screen: stateScreen('signin') }
  try {
    return initialState(ds, buildItems(ds, cfg.sources, STATIC_ALTS), { clock: ctx.clock, states: cfg.states })
  } catch {
    // review finding 8: a build error is the F error state, never a blank screen
    return { items: [], sent: [], screen: stateScreen('error') }
  }
}

function toContainers(spec: PageSpec) {
  const textObject: TextContainerProperty[] = []
  const listObject: ListContainerProperty[] = []
  spec.boxes.forEach((b, i) => {
    const common = {
      xPosition: b.x,
      yPosition: b.y,
      width: b.w,
      height: b.h,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: b.pad,
      containerID: i + 1,
      containerName: b.name,
      isEventCapture: b.capture ? 1 : 0,
    }
    if (b.kind === 'text') textObject.push(new TextContainerProperty({ ...common, content: b.content }))
    else
      listObject.push(
        new ListContainerProperty({
          ...common,
          itemContainer: new ListItemContainerProperty({
            itemCount: b.items.length,
            itemWidth: 0,
            isItemSelectBorderEn: 1,
            itemName: b.items,
          }),
        }),
      )
  })
  return { containerTotalNum: spec.boxes.length, textObject, listObject }
}

async function render(bridge: EvenAppBridge): Promise<void> {
  const spec = pageFor(state, ctx)
  const c = toContainers(spec)
  let ok: boolean
  drawing = true // review finding 2: input is dropped until the new page is drawn
  try {
    if (!started) {
      const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(c))
      ok = r === 0
      started = ok
    } else {
      ok = await bridge.rebuildPageContainer(new RebuildPageContainer(c))
    }
    page = spec
    drawnAt = performance.now()
  } finally {
    drawing = false
  }
  if (client) followRetry()
  followSignin()
  // one machine-readable line per drawn page: `npm run shots` reads it back to run the line-width check
  console.log(`BRIEF_PAGE ${JSON.stringify({ ok, spec })}`)
}

function failScreen(e: unknown): Screen {
  const kind = e instanceof BackendError ? e.kind : 'error'
  return stateScreen(kind === 'gone' || kind === 'failed' ? 'error' : kind)
}

// « No connection — retrying » retries by itself: 2 s, 5 s, 15 s, then every 30 s; stopped in the background.
const retry = createRetry(
  { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  () => {
    queue = queue.then(() => (isOffline() && bridgeRef ? load(bridgeRef) : undefined))
  },
)
let bridgeRef: EvenAppBridge | undefined

function isOffline(): boolean {
  return state.screen.kind === 'state' && state.screen.which === 'offline'
}

/** After each page (backend mode): « No connection » arms the next retry; `Working…` keeps the count; else stop. */
function followRetry(): void {
  if (isOffline()) retry.arm()
  else if (!(state.screen.kind === 'state' && state.screen.which === 'working')) retry.stop()
}

/** Backend mode: (re)load the list, then the calendar. Any list failure = an F state with a plain line; a calendar
 * failure never blocks the list (the header then has no clock and no `next`). */
async function load(bridge: EvenAppBridge): Promise<void> {
  if (!client) return
  retry.disarm() // a press on « No connection » retries at once; the timer is armed again only if this one fails
  state = { ...state, screen: stateScreen('working') }
  await render(bridge)
  try {
    if (!client.mode()) await client.start(REQUIRE_PAIRING)
    const items: Item[] = await client.items(cfg.sources, REQUIRE_PAIRING)
    try {
      const cal = await client.calendar()
      ctx.clock = cal.now
      ctx.calendar = cal.events
    } catch {
      // BRIEF-D4.md § 3.11: the header keeps a clock (the device's own) and simply has no `next`
      ctx.clock = cfg.clock ?? localClock(new Date()) // `?at=` exists on the dev server only (the screenshot walk)
      ctx.calendar = []
    }
    state = initialState(ds, items, { clock: ctx.clock, events: ctx.calendar })
  } catch (e) {
    state = { ...state, items: [], screen: failScreen(e) }
  }
  showSource()
  await render(bridge)
}

/** The 2-second tick: after `Sent`, and after `Already handled.` (then the list is read again). */
function needsTick(): boolean {
  const s = state.screen
  return s.kind === 'sent' || (s.kind === 'state' && s.which === 'handled')
}

function armSentTimer(bridge: EvenAppBridge): void {
  if (sentTimer) clearTimeout(sentTimer)
  sentTimer = setTimeout(() => dispatch(bridge, { type: 'tick' }), 2000)
}

function dispatch(bridge: EvenAppBridge, input: Input): void {
  queue = queue.then(async () => {
    const before = state
    const step = reduce(state, input, briefPages(ctx).length)
    if (step.effect === 'exit-dialog') {
      // the system exit dialog; nothing is cleaned up here, the user can still cancel
      await bridge.shutDownPageContainer(1)
      return
    }
    if (step.effect === 'reload' && client) return load(bridge)
    if (step.effect === 'fake-send' && client) {
      // backend: `Sent` only after a 200; until then `Working…`, and a failure is an F state (nothing was sent)
      const s = before.screen
      if (s.kind !== 'confirm') return
      state = { ...before, screen: stateScreen('working') }
      await render(bridge)
      try {
        // the choice posted = the index of the text C shows (backend.ts choiceFor): a retry after `send_failed` keeps C's
        // text, so it posts the same index again
        const r = await client.send(s.id, s.draft)
        console.log(`BRIEF_SENT ${JSON.stringify({ id: s.id, real: r.real })}`)
        const sent = step.state.screen
        state = sent.kind === 'sent' ? { ...step.state, screen: { ...sent, real: r.real } } : step.state
        armSentTimer(bridge)
      } catch (e) {
        const next = afterSendFailure(before, e instanceof BackendError ? e.kind : 'error')
        if (!next) return load(bridge)
        state = next
        if (needsTick()) armSentTimer(bridge)
      }
      return render(bridge)
    }
    if (step.effect === 'skip' && client && before.screen.kind === 'mail') {
      const id = before.screen.id
      try {
        await client.skip(id)
        state = { ...step.state, items: step.state.items.filter((i) => i.id !== id) }
      } catch (e) {
        state = afterSkipFailure(step.state, id, e instanceof BackendError ? e.kind : 'error')
        if (needsTick()) armSentTimer(bridge)
      }
      return render(bridge)
    }
    const changed = step.state !== state
    state = step.state
    if (step.effect === 'fake-send') {
      const last = state.sent[state.sent.length - 1]
      console.log(`BRIEF_FAKE_SEND ${JSON.stringify(last)} (static demo: nothing leaves the app)`)
      armSentTimer(bridge)
    }
    if (changed) await render(bridge)
  })
}

const SOURCE_TEXT = {
  static: 'Demo data — built into the app. Nothing is fetched or sent.',
  demo: 'Demo data — from the Brief server. Nothing is sent.',
  // day 4: true whether the server's REAL_SEND is on or off (the app cannot know which; the glasses say it after each send)
  paired:
    'Your inbox — the label brief-demo of the account you signed in with. « Send now » sends a real reply from your Gmail, only to your own +alias address. When sending is switched off, the glasses say « Demo: no real mail was sent ».',
  none: 'Not connected yet.',
} as const

/** The phone-side page: which data the glasses show, and « Disconnect » only while paired. */
function showSource(): void {
  const el = document.querySelector<HTMLElement>('#source')
  const disc = document.querySelector<HTMLButtonElement>('#disconnect')
  const mode = client ? client.mode() : 'static'
  if (el) el.textContent = SOURCE_TEXT[mode ?? 'none']
  if (disc) disc.hidden = mode !== 'paired'
}

function tell(text: string): void {
  const status = document.querySelector<HTMLElement>('#pair-status')
  if (status) status.textContent = text
}

/** The phone-side status never contradicts the glasses: while a PAIRED session shows « Sign-in needed » (403: its Google
 * grant is dead, the session is kept), an older « Paired… » line is replaced, once per entry into that state. */
let saidSignin = false
function followSignin(): void {
  const dead = client?.mode() === 'paired' && state.screen.kind === 'state' && state.screen.which === 'signin'
  if (dead && !saidSignin) tell('Google sign-in is needed again: do the two steps above, then type the new code here.')
  saidSignin = dead
}

/** The phone-side page (the WebView, not the glasses): « Have a code? » → a paired session → the list reloads;
 * « Disconnect » → the paired session is forgotten → back to demo. */
function wirePairingForm(bridge: EvenAppBridge): void {
  const form = document.querySelector<HTMLFormElement>('#pair')
  const input = document.querySelector<HTMLInputElement>('#pair-code')
  const status = document.querySelector<HTMLElement>('#pair-status')
  const disc = document.querySelector<HTMLButtonElement>('#disconnect')
  if (!form || !input || !status || !client) return
  const c = client
  form.hidden = false
  disc?.addEventListener('click', () => {
    queue = queue.then(async () => {
      tell('Closing your session…')
      await c.disconnect()
      tell('Disconnected. Your session is closed and this phone no longer keeps it. The glasses show demo data.')
      showSource()
      await load(bridge)
    })
  })
  const say: Record<string, string> = {
    gone: "That code didn't work. A code has 6 digits, lasts 10 minutes and works once.",
    later: 'Too many tries. Wait 10 minutes, then try again.',
    limit: 'Too many tries. Wait 10 minutes, then try again.',
    offline: 'No connection. Check the phone is online, then try again.',
    signin: 'Sign-in is not open for this account yet.',
    error: 'Something went wrong on our side. Nothing was changed. Try again later.',
  }
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const code = input.value.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(code)) {
      status.textContent = 'Type the 6 digits shown after you signed in.'
      return
    }
    status.textContent = 'Checking…'
    c.claim(code).then(
      () => {
        input.value = ''
        status.textContent = 'Paired. Your list is reloading on the glasses.'
        queue = queue.then(() => load(bridge))
      },
      (e: unknown) => {
        status.textContent = say[e instanceof BackendError ? e.kind : 'error'] ?? say.error
      },
    )
  })
}

/** The phone-side sign-in help: the same two steps as the glasses, the address as plain text and a copy button (Google
 * refuses sign-in inside this WebView, so no link here is counted on). */
function wireSigninHelp(): void {
  const addr = document.querySelector<HTMLElement>('#connect-address')
  const copy = document.querySelector<HTMLButtonElement>('#connect-copy')
  const said = document.querySelector<HTMLElement>('#connect-copied')
  if (addr) addr.textContent = CONNECT_ADDRESS
  copy?.addEventListener('click', () => {
    const done = (ok: boolean) => {
      if (said) said.textContent = ok ? 'Copied.' : 'Copy did not work here: select the address and copy it by hand.'
    }
    if (!navigator.clipboard) return done(false)
    navigator.clipboard.writeText(CONNECT_ADDRESS).then(() => done(true), () => done(false))
  })
}

wireSigninHelp()
const bridge = await waitForEvenAppBridge()
bridgeRef = bridge
bridge.onEvenHubEvent((event) => {
  const side = sideSignal(event)
  if (side === 'background') {
    if (sentTimer) clearTimeout(sentTimer)
    retry.pause()
  } else if (side === 'foreground') {
    if (needsTick()) armSentTimer(bridge)
    retry.resume()
  }
  const input = toInput(event, page, drawing, performance.now() - drawnAt)
  if (input) dispatch(bridge, input)
})
showSource()
if (backend) {
  client = createClient({
    base: API_BASE,
    fetch: (url, init) => fetch(url, init),
    storage: bridgeStorage(bridge),
    onPairedDropped: () => {
      tell('Your paired session ended, so this phone forgot it. Type a new code to see your inbox again; a press on the glasses shows demo data.')
      showSource()
    },
  })
  wirePairingForm(bridge)
  if (import.meta.env.DEV) {
    // dev-only pairing (src/dev-pair.ts): the simulator cannot type in this page, so `?pair=<6 digits>` pairs at start (dev server only;
    // Vite drops this branch and the module from every production build)
    const c = client
    queue = queue.then(async () => {
      const { devPair } = await import('./dev-pair.ts')
      const r = await devPair({ href: location.href, claim: (code) => c.claim(code), replace: (h) => history.replaceState(null, '', h) })
      if (r !== 'none') tell(r === 'paired' ? 'Paired from the address (dev server).' : "The code in the address didn't work.")
    })
  }
  queue = queue.then(() => load(bridge))
} else {
  queue = queue.then(() => render(bridge))
}
await queue
console.log('BRIEF_READY')
