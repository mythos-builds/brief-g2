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

/** What a sys event asks of main.ts besides an Input: 6 / 7 = the app goes to the background / comes back. */
export type SideSignal = 'background' | undefined

export function sideSignal(event: HubEvent): SideSignal {
  const t = event.sysEvent?.eventType ?? 0
  return event.sysEvent && (t === 6 || t === 7) ? 'background' : undefined
}

/**
 * `page` = the page the glasses show now (undefined before the first one); `drawing` = a page is in flight.
 * Double-press is the system exit dialog and stays live even while drawing (it changes no state).
 */
export function toInput(event: HubEvent, page: PageSpec | undefined, drawing: boolean): Input | undefined {
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
