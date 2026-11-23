// Display limits, measured with @evenrealities/pretext (the font-measurement skill's library: the glyph widths
// LVGL uses on G2), never guessed. Used by the page builder, by `npm test` and by `npm run shots`.
import { getAdvW, getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import type { Box, PageSpec } from './types.ts'

export const SCREEN_W = 576
export const SCREEN_H = 288
export const LINE_H = 27
export const LIST_ITEM_H = 40
export const LIST_ITEM_PAD = 12 // per side, inside a list item
export const MAX_TEXT_LINES = 4 // per screen, all text containers together (PREP.md UX rule)
export const MAX_CONTAINERS = 12
export const MAX_TEXT_LIST = 8
export const MAX_LIST_ITEMS = 20
export const MAX_LIST_ITEM_CHARS = 64
export const MAX_TEXT_CHARS = 1000 // create / rebuild
export const MAX_NAME_CHARS = 16

export function innerWidth(b: Box): number {
  return b.kind === 'text' ? b.w - 2 * b.pad : b.w - 2 * b.pad - 2 * LIST_ITEM_PAD
}

export function textWidth(s: string): number {
  return getTextWidth(s)
}

/** Wrapped lines of a text container, with each line's measured width. */
export function wrap(content: string, maxWidth: number): { lineCount: number; lineWidths: number[] } {
  const r = measureTextWrap(content, maxWidth)
  return { lineCount: r.lineCount, lineWidths: r.lineWidths }
}

/** Characters the firmware font has no glyph for (they would not show on the glasses). */
export function missingGlyphs(s: string): string[] {
  const out = new Set<string>()
  for (const ch of s) {
    if (/\s/.test(ch)) continue
    if (getAdvW(ch.codePointAt(0) ?? 0) === 0) out.add(`U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')} ${ch}`)
  }
  return [...out]
}

export interface PageReport {
  screen: string
  textLines: number
  widestLine: number // px, over every text line and list item on the page
  problems: string[]
}

/** Every limit of a page: container count, one capture, bounds, ≤ 4 text lines, no line wider than its box (≤ 576 px). */
export function checkPage(page: PageSpec): PageReport {
  const problems: string[] = []
  const boxes = page.boxes
  let textLines = 0
  let widest = 0

  if (boxes.length < 1 || boxes.length > MAX_CONTAINERS) problems.push(`${boxes.length} containers (1–${MAX_CONTAINERS})`)
  if (boxes.length > MAX_TEXT_LIST) problems.push(`${boxes.length} text/list containers (max ${MAX_TEXT_LIST})`)
  const captures = boxes.filter((b) => b.capture).length
  if (captures !== 1) problems.push(`${captures} event-capture containers (exactly 1)`)
  const names = new Set<string>()

  for (const b of boxes) {
    if (names.has(b.name)) problems.push(`duplicate container name ${b.name}`)
    names.add(b.name)
    if (b.name.length > MAX_NAME_CHARS) problems.push(`${b.name}: name over ${MAX_NAME_CHARS} characters`)
    if (b.x < 0 || b.y < 0 || b.x + b.w > SCREEN_W || b.y + b.h > SCREEN_H) problems.push(`${b.name}: outside 576×288`)
    const inner = innerWidth(b)

    if (b.kind === 'text') {
      if (b.content.length > MAX_TEXT_CHARS) problems.push(`${b.name}: ${b.content.length} characters (max ${MAX_TEXT_CHARS})`)
      const w = wrap(b.content, inner)
      textLines += w.lineCount
      const fit = Math.floor((b.h - 2 * b.pad) / LINE_H)
      if (w.lineCount > fit) problems.push(`${b.name}: ${w.lineCount} lines in a box that holds ${fit}`)
      for (const lw of w.lineWidths) {
        widest = Math.max(widest, b.x + b.pad + lw)
        if (lw > inner) problems.push(`${b.name}: a line is ${lw} px wide, box inner width ${inner} px`)
      }
      for (const g of missingGlyphs(b.content)) problems.push(`${b.name}: no firmware glyph for ${g}`)
    } else {
      if (b.items.length < 1 || b.items.length > MAX_LIST_ITEMS) problems.push(`${b.name}: ${b.items.length} items (1–${MAX_LIST_ITEMS})`)
      for (const it of b.items) {
        if (it.length > MAX_LIST_ITEM_CHARS) problems.push(`${b.name}: item over ${MAX_LIST_ITEM_CHARS} characters: ${it}`)
        const lw = getTextWidth(it)
        widest = Math.max(widest, b.x + b.pad + LIST_ITEM_PAD + lw)
        if (lw > inner) problems.push(`${b.name}: item ${lw} px wide, inner width ${inner} px: ${it}`)
        for (const g of missingGlyphs(it)) problems.push(`${b.name}: no firmware glyph for ${g}`)
      }
      // more items than rows is fine (the firmware scrolls the list); less than one row is not
      if (b.h - 2 * b.pad < LIST_ITEM_H) problems.push(`${b.name}: ${b.h} px is less than one ${LIST_ITEM_H} px row`)
    }
  }
  if (textLines > MAX_TEXT_LINES) problems.push(`${textLines} text lines on one screen (max ${MAX_TEXT_LINES})`)
  if (widest > SCREEN_W) problems.push(`widest line ends at ${widest} px (max ${SCREEN_W})`)
  return { screen: page.screen, textLines, widestLine: widest, problems }
}
