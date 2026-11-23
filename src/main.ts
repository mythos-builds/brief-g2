// Glue: SDK bridge ⇄ the pure state machine. Static demo data only; nothing is fetched, nothing is sent.
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import dataset from './data/dataset.json'
import { STATIC_ALTS } from './data/static-alts.ts'
import { readConfig } from './config.ts'
import { buildItems, clockOf } from './logic/items.ts'
import { initialState, reduce } from './logic/flow.ts'
import { briefPages, pageFor, type PageContext } from './logic/pages.ts'
import type { AppState, Dataset, Input, PageSpec } from './logic/types.ts'

const ds = dataset as Dataset
const cfg = readConfig(location.search)
const ctx: PageContext = { ds, clock: cfg.clock ?? clockOf(ds.now), sources: cfg.sources }
let state: AppState = initialState(ds, buildItems(ds, cfg.sources, STATIC_ALTS), { clock: ctx.clock, states: cfg.states })
let page: PageSpec | undefined
let started = false
let queue: Promise<void> = Promise.resolve()
let sentTimer: ReturnType<typeof setTimeout> | undefined

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
  if (!started) {
    const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(c))
    ok = r === 0
    started = ok
  } else {
    ok = await bridge.rebuildPageContainer(new RebuildPageContainer(c))
  }
  page = spec
  // one machine-readable line per drawn page: `npm run shots` reads it back to run the line-width check
  console.log(`BRIEF_PAGE ${JSON.stringify({ ok, spec })}`)
}

function dispatch(bridge: EvenAppBridge, input: Input): void {
  queue = queue.then(async () => {
    const step = reduce(state, input, briefPages(ctx).length)
    if (step.effect === 'exit-dialog') {
      // the system exit dialog; nothing is cleaned up here, the user can still cancel
      await bridge.shutDownPageContainer(1)
      return
    }
    const changed = step.state !== state
    state = step.state
    if (step.effect === 'fake-send') {
      const last = state.sent[state.sent.length - 1]
      console.log(`BRIEF_FAKE_SEND ${JSON.stringify(last)} (static demo: nothing leaves the app)`)
      if (sentTimer) clearTimeout(sentTimer)
      sentTimer = setTimeout(() => dispatch(bridge, { type: 'tick' }), 2000)
    }
    if (changed) await render(bridge)
  })
}

function toInput(event: EvenHubEvent): Input | undefined {
  const listCapture = page?.boxes.some((b) => b.capture && b.kind === 'list') ?? false
  if (event.listEvent) {
    const t = event.listEvent.eventType ?? 0
    if (t === 3) return { type: 'double' }
    if (t !== 0) return undefined // scroll inside a list = the firmware's own cursor move
    return { type: 'press', index: event.listEvent.currentSelectItemIndex ?? 0 }
  }
  if (event.textEvent) {
    const t = event.textEvent.eventType ?? 0
    if (t === 1) return { type: 'up' }
    if (t === 2) return { type: 'down' }
    return undefined
  }
  if (event.sysEvent) {
    const t = event.sysEvent.eventType ?? 0
    if (t === 3) return { type: 'double' }
    if (t === 0 && !listCapture) return { type: 'press' }
    if (t === 6 || t === 7) {
      if (sentTimer) clearTimeout(sentTimer)
    }
  }
  return undefined
}

const bridge = await waitForEvenAppBridge()
bridge.onEvenHubEvent((event) => {
  const input = toInput(event)
  if (input) dispatch(bridge, input)
})
queue = queue.then(() => render(bridge))
await queue
console.log('BRIEF_READY')
