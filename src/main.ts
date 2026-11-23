// Glue: SDK bridge ⇄ the pure state machine ⇄ the data (static demo data, or the Brief Worker in backend mode).
// Static mode (default): nothing is fetched, nothing is sent. Backend mode (VITE_DATA_SOURCE=backend): BRIEF-D2.md § 3;
// on day 2 the Worker sends nothing either ({"sent":true,"real":false}).
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
import { API_BASE, DATA_SOURCE, readConfig, REQUIRE_PAIRING, URL_SWITCHES } from './config.ts'
import { BackendError, createClient, type Client } from './data/backend.ts'
import { buildItems, clockOf } from './logic/items.ts'
import { initialState, reduce } from './logic/flow.ts'
import { sideSignal, toInput } from './logic/input.ts'
import { briefPages, pageFor, type PageContext } from './logic/pages.ts'
import type { AppState, Dataset, Input, Item, PageSpec, Screen, StateName } from './logic/types.ts'

const ds = dataset as Dataset
const cfg = readConfig(URL_SWITCHES ? location.search : '')
const ctx: PageContext = { ds, clock: cfg.clock ?? clockOf(ds.now), sources: cfg.sources }
const backend = DATA_SOURCE === 'backend'
let state: AppState = firstState()
let page: PageSpec | undefined
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
  } finally {
    drawing = false
  }
  // one machine-readable line per drawn page: `npm run shots` reads it back to run the line-width check
  console.log(`BRIEF_PAGE ${JSON.stringify({ ok, spec })}`)
}

function failScreen(e: unknown): Screen {
  const kind = e instanceof BackendError ? e.kind : 'error'
  return stateScreen(kind === 'gone' ? 'error' : kind)
}

/** Backend mode: (re)load the list. Any failure = an F state with a plain line. */
async function load(bridge: EvenAppBridge): Promise<void> {
  if (!client) return
  state = { ...state, screen: stateScreen('working') }
  await render(bridge)
  try {
    if (!client.mode()) await client.start(REQUIRE_PAIRING)
    const items: Item[] = await client.items(cfg.sources, REQUIRE_PAIRING)
    state = initialState(ds, items, { clock: ctx.clock })
  } catch (e) {
    state = { ...state, items: [], screen: failScreen(e) }
  }
  await render(bridge)
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
        const r = await client.send(s.id, s.draft)
        console.log(`BRIEF_SENT ${JSON.stringify({ id: s.id, real: r.real })}`)
        state = step.state
        armSentTimer(bridge)
      } catch (e) {
        if (e instanceof BackendError && e.kind === 'gone') return load(bridge)
        state = { ...before, screen: failScreen(e) }
      }
      return render(bridge)
    }
    if (step.effect === 'skip' && client && before.screen.kind === 'mail') {
      const id = before.screen.id
      try {
        await client.skip(id)
        state = { ...step.state, items: step.state.items.filter((i) => i.id !== id) }
      } catch (e) {
        if (e instanceof BackendError && e.kind === 'gone') state = { ...step.state, items: step.state.items.filter((i) => i.id !== id) }
        else state = { ...step.state, screen: failScreen(e) }
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

/** The phone-side page (the WebView, not the glasses): « Have a code? » → a paired session → the list reloads. */
function wirePairingForm(bridge: EvenAppBridge): void {
  const form = document.querySelector<HTMLFormElement>('#pair')
  const input = document.querySelector<HTMLInputElement>('#pair-code')
  const status = document.querySelector<HTMLElement>('#pair-status')
  if (!form || !input || !status || !client) return
  const c = client
  form.hidden = false
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

const bridge = await waitForEvenAppBridge()
bridge.onEvenHubEvent((event) => {
  if (sideSignal(event) === 'background' && sentTimer) clearTimeout(sentTimer)
  const input = toInput(event, page, drawing)
  if (input) dispatch(bridge, input)
})
if (backend) {
  client = createClient({
    base: API_BASE,
    fetch: (url, init) => fetch(url, init),
    storage: {
      get: (k) => bridge.getLocalStorage(k),
      set: (k, v) => bridge.setLocalStorage(k, v),
    },
  })
  wirePairingForm(bridge)
  queue = queue.then(() => load(bridge))
} else {
  queue = queue.then(() => render(bridge))
}
await queue
console.log('BRIEF_READY')
