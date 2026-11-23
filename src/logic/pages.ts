// State → page description (pure data). Layout from SCREENS.md; every text is fitted with measured widths.
import { pxTruncate } from '@evenrealities/pretext'
import type { AppState, Dataset, Item, ListBox, PageSpec, StateName, TextBox } from './types.ts'
import { actItems, altItems, CONFIRM_ITEMS, findItem, LIST_OF } from './flow.ts'
import { briefDue, companyOf, homeLabel, needLine, nextEvent, shownTime, summaryLine } from './items.ts'
import { DRAFT_PREFIX } from './replies.ts'
import { LIST_ITEM_H, LIST_ITEM_PAD, MAX_LIST_ITEM_CHARS, MAX_TEXT_LINES, SCREEN_H, SCREEN_W, wrap } from './measure.ts'

export const TEXT_PAD = 4
// SCREENS.md writes `Sent ✓`, but the G2 firmware font has no U+2713 glyph (pretext advance width 0, and the
// simulator draws nothing for it: docs/screens/ first run). √ (U+221A) is in the font and reads as a tick.
export const CHECK = '√'
export const DOMAIN = 'brief.appfinishers.com'

export const STATE_TEXT: Record<StateName, string> = {
  signin: `Sign-in needed — open ${DOMAIN} on your phone, type the 6-digit code here`,
  offline: 'No connection — retrying',
  working: 'Working…',
  error: "Couldn't load your items. Nothing was sent. Press to try again.",
  later: 'Too many tries — wait a few minutes, then press to try again',
  limit: "Today's demo limit is reached. Nothing was sent. Try again tomorrow.",
}

export interface PageContext {
  ds: Dataset
  clock: string // "HH:MM"
  sources: readonly ('mail' | 'telegram')[]
}

function text(name: string, x: number, y: number, w: number, h: number, content: string, capture = false): TextBox {
  return { kind: 'text', name, x, y, w, h, pad: TEXT_PAD, capture, content }
}

function list(name: string, y: number, maxH: number, items: string[], capture = true): ListBox {
  const h = Math.min(maxH, Math.max(1, items.length) * LIST_ITEM_H)
  return { kind: 'list', name, x: 0, y, w: SCREEN_W, h, pad: 0, capture, items }
}

/** Fit one line into a box's inner width: measured, cut with `...` only when it does not fit. */
function fitLine(s: string, box: { w: number; pad: number; kind: 'text' | 'list' }): string {
  const inner = box.kind === 'list' ? box.w - 2 * box.pad - 2 * LIST_ITEM_PAD : box.w - 2 * box.pad
  let out = pxTruncate(s, inner)
  if (box.kind === 'list' && out.length > MAX_LIST_ITEM_CHARS) out = pxTruncate(out.slice(0, MAX_LIST_ITEM_CHARS - 3), inner) + '...'
  return out
}

function lines(content: string, w: number): number {
  return wrap(content, w - 2 * TEXT_PAD).lineCount
}

function fromLine(item: Item): string {
  const at = shownTime(item.at)
  const tail = at ? ` · ${at}` : ''
  return item.source === 'telegram' ? `TG · ${item.name} (${item.chat})${tail}` : `From ${item.name}${tail}`
}

function homePage(state: AppState, ctx: PageContext): PageSpec {
  const next = nextEvent(ctx.ds, ctx.clock)
  if (state.items.length === 0) {
    const content = next ? `Inbox clear ${CHECK}  ${next}` : `Inbox clear ${CHECK}`
    return { screen: 'A', boxes: [text('empty', 0, 0, SCREEN_W, SCREEN_H, content, true)] }
  }
  const head = needLine(state.items, ctx.sources)
  // the longest header that fits one line: counts · clock · next event
  const candidates = [next ? `${head} · ${ctx.clock} · ${next}` : '', `${head} · ${ctx.clock}`, head].filter(Boolean)
  const hdr = candidates.find((c) => lines(c, SCREEN_W) === 1) ?? head
  const labels = state.items.slice(0, 20).map((i) => fitLine(homeLabel(i), { kind: 'list', w: SCREEN_W, pad: 0 }))
  return {
    screen: 'A',
    boxes: [text('hdr', 0, 0, SCREEN_W, 36, hdr), list(LIST_OF.home, 44, 240, labels)],
  }
}

function mailPage(item: Item, draft: string): PageSpec {
  const from = fromLine(item)
  // a refused draft (src/logic/replies.ts) is never shown: B then offers the alternatives or Skip, never Send
  const draftLine = draft ? `${DRAFT_PREFIX}${draft}` : 'No draft to send — see Other answers'
  let summary = summaryLine(item)
  // ≤ 4 text lines: the summary gives way first (one line, cut where it fits), never the draft
  if (lines([from, summary, draftLine].join('\n'), SCREEN_W) > MAX_TEXT_LINES)
    summary = fitLine(summary, { kind: 'text', w: SCREEN_W, pad: TEXT_PAD })
  const content = [from, summary, draftLine].join('\n')
  return {
    screen: 'B',
    boxes: [text('mail', 0, 0, SCREEN_W, 148, content), list(LIST_OF.mail, 160, 120, actItems(item, draft))],
  }
}

function altsPage(item: Item): PageSpec {
  const hdr = fitLine(homeLabel(item), { kind: 'text', w: SCREEN_W, pad: TEXT_PAD })
  // the alternatives were validated (≤ 60 characters, one line) when the item was built: never cut here
  return { screen: 'D2', boxes: [text('hdr', 0, 0, SCREEN_W, 36, hdr), list(LIST_OF.alts, 44, 240, altItems(item))] }
}

function confirmPage(item: Item, draft: string): PageSpec {
  const who =
    item.source === 'telegram'
      ? [`To: ${item.name} · Telegram, ${item.chat}`, 'via your Brief bot']
      : [`To: ${item.fullName}`, fitLine(item.address, { kind: 'text', w: SCREEN_W, pad: TEXT_PAD })]
  const content = [...who, draft].join('\n')
  return {
    screen: 'C',
    boxes: [text('who', 0, 0, SCREEN_W, 148, content), list(LIST_OF.confirm, 160, 80, [...CONFIRM_ITEMS])],
  }
}

/** E, pre-paginated: page 1 = when · who · why · last; page 2 = the facts. */
export function briefPages(ctx: PageContext): string[] {
  const i = briefDue(ctx.ds, ctx.clock)
  const ev = i >= 0 ? ctx.ds.calendar[i] : ctx.ds.calendar.find((e) => e.brief)
  if (!ev || !ev.brief) return ['No meeting brief']
  const p = ctx.ds.personas[ev.with]
  const company = companyOf(p?.email)
  const who = p ? `Who: ${p.name}${company ? `, ${company}` : ''}` : ''
  const page1 = [`${ev.start} · ${ev.title}`, who, `Why: ${ev.brief.why}`, `Last: ${ev.brief.last}`].filter(Boolean)
  const page2 = ev.brief.facts.slice(0, 4).map((f) => `• ${f}`)
  return [page1.join('\n'), page2.join('\n')]
}

export function pageFor(state: AppState, ctx: PageContext): PageSpec {
  const s = state.screen
  switch (s.kind) {
    case 'home':
      return homePage(state, ctx)
    case 'mail':
    case 'alts':
    case 'confirm': {
      const item = findItem(state, s.id)
      if (!item) return homePage(state, ctx)
      if (s.kind === 'mail') return mailPage(item, s.draft)
      if (s.kind === 'alts') return altsPage(item)
      return confirmPage(item, s.draft)
    }
    case 'sent': {
      const msg = s.source === 'telegram' ? `Sent on Telegram ${CHECK}` : `Sent ${CHECK}`
      return { screen: 'SENT', boxes: [text('sent', 0, 0, SCREEN_W, SCREEN_H, msg, true)] }
    }
    case 'brief': {
      const pages = briefPages(ctx)
      const content = pages[Math.min(s.page, pages.length - 1)]
      return { screen: 'E', boxes: [text('brief', 0, 0, SCREEN_W, SCREEN_H, content, true)] }
    }
    case 'state':
      return { screen: 'F', boxes: [text('state', 0, 0, SCREEN_W, SCREEN_H, STATE_TEXT[s.which], true)] }
  }
}
