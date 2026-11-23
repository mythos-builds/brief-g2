// SDK event → Input, pure (no SDK import) so `npm test` covers it. Review finding 2: a list press is tied to the page
// drawn now (its capture list's container name and the row's label), and every input is dropped while a page is being
// drawn: the glasses still show the page before, so a press then was aimed at a page that is going away.
import type { Input, PageSpec } from './types.ts'

/** The fields of the SDK's EvenHubEvent this app reads (index.d.ts: List_ItemEvent, Text_ItemEvent, Sys_ItemEvent). */
export interface HubEvent {
  listEvent?: { containerName?: string; currentSelectItemName?: string; currentSelectItemIndex?: number; eventType?: number }
  textEvent?: { eventType?: number }
  sysEvent?: { eventType?: number }
}

/**
 * What a sys event asks of main.ts besides an Input. The SDK's OsEventTypeList (index.d.ts): 4 FOREGROUND_ENTER_EVENT,
 * 5 FOREGROUND_EXIT_EVENT, 6 ABNORMAL_EXIT_EVENT, 7 SYSTEM_EXIT_EVENT. 5 / 6 / 7 = the app leaves the foreground
 * (timers stop); 4 = it is back (the « No connection » retry resumes).
 */
export type SideSignal = 'background' | 'foreground' | undefined

export function sideSignal(event: HubEvent): SideSignal {
  if (!event.sysEvent) return undefined
  const t = event.sysEvent.eventType ?? 0
  if (t === 5 || t === 6 || t === 7) return 'background'
  if (t === 4) return 'foreground'
  return undefined
}

/**
 * A list press is accepted only once the page now drawn has been up this long: an event may not name its list or its
 * row (all List_ItemEvent fields are optional in the SDK's index.d.ts, and protobuf drops empty values), and even a
 * named one cannot be told apart from a press on the page before when both pages share the list and rows (D3 review,
 * finding 2: two B pages in a row), so it must not land on a page the user has not yet seen.
 */
export const UNNAMED_PRESS_MIN_MS = 300

/**
 * `page` = the page the glasses show now (undefined before the first one); `drawing` = a page is in flight;
 * `shownMs` = how long `page` has been up (ms). Double-press is the system exit dialog and stays live even while
 * drawing (it changes no state). List press: a name the event carries must match the page drawn now (else dropped),
 * and every list press is accepted only after UNNAMED_PRESS_MIN_MS.
 */
export function toInput(event: HubEvent, page: PageSpec | undefined, drawing: boolean, shownMs: number): Input | undefined {
  const capture = page?.boxes.find((b) => b.capture)
  const le = event.listEvent
  if (le) {
    const t = le.eventType ?? 0
    if (t === 3) return { type: 'double' }
    if (t !== 0) return undefined // scroll inside a list = the firmware's own cursor move
    if (drawing || !capture || capture.kind !== 'list') return undefined
    // the event names another list (the page before): drop it
    if (le.containerName !== undefined && le.containerName !== capture.name) return undefined
    const index = le.currentSelectItemIndex ?? 0
    const row = capture.items[index]
    if (row === undefined) return undefined
    // the event names a row that is not the one at its index on this page: drop it
    if (le.currentSelectItemName !== undefined && le.currentSelectItemName !== row) return undefined
    // review note 10 + D3 review finding 2: even a list and row name cannot tie the event to this page (every item's B
    // page has the same list `act` and the same rows), so every list press needs the page up for UNNAMED_PRESS_MIN_MS
    if (!(shownMs >= UNNAMED_PRESS_MIN_MS)) return undefined
    return { type: 'press', index, list: capture.name, label: row }
  }
  if (event.textEvent) {
    const t = event.textEvent.eventType ?? 0
    if (drawing) return undefined
    if (t === 1) return { type: 'up' }
    if (t === 2) return { type: 'down' }
    return undefined
  }
  if (event.sysEvent) {
    const t = event.sysEvent.eventType ?? 0
    if (t === 3) return { type: 'double' }
    if (drawing) return undefined
    if (t === 0 && capture?.kind !== 'list') return { type: 'press' }
  }
  return undefined
}
