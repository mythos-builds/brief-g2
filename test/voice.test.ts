// BRIEF-D5.md § 4 (job A): « Speak a change » on the glasses. § 3.10 word by word (each measured), every way out of the
// microphone (fake clock, fake bridge that records audioControl), the choice posted (§ 4.2), static mode (§ 4.3), the
// dev-only clip (§ 3.11), the stub's § 3.2 / 3.6 / 3.7.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getAdvW } from '@evenrealities/pretext'
import { loadDataset } from './helpers.ts'
import { memoryStorage, revOf, stubBackend, STUB_SPOKEN } from './stub-backend.ts'
import { BackendError, baseFor, createClient, failureOf, type FetchLike } from '../src/data/backend.ts'
import { buildItems } from '../src/logic/items.ts'
import {
  ACT_OTHER,
  ACT_SEND,
  ACT_SKIP,
  ACT_SPEAK,
  actItems,
  afterMic,
  afterSendFailure,
  afterSpeak,
  MAX_CLIP_BYTES,
  MIN_CLIP_BYTES,
  reduce,
  SEND_NOW,
  type MicStop,
} from '../src/logic/flow.ts'
import { LISTEN_BOX, pageFor, REWRITING_TEXT, VOICE_TEXT, type PageContext } from '../src/logic/pages.ts'
import { checkPage, SCREEN_H } from '../src/logic/measure.ts'
import {
  BAR_CELLS,
  BAR_OFF,
  BAR_ON,
  createRecorder,
  LEVEL_EVERY_MS,
  levelBar,
  levelOf,
  listenText,
  LISTEN_MAX_MS,
  NO_AUDIO_MS,
  pcmOf,
  type Clock,
  type Mic,
} from '../src/logic/recorder.ts'
import { sideSignal } from '../src/logic/input.ts'
import { clipMic, clipUrlOf, CHUNK_BYTES, DEV_VOICE_MARKER, samplesOf } from '../src/dev-voice.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import type { AppState, Item, ListBox, MailScreen, TextBox, VoiceMsg } from '../src/logic/types.ts'

const ds = loadDataset()
const ITEMS: Item[] = buildItems(ds, ['mail'], STATIC_ALTS)
const BASE = 'https://brief.appfinishers.com'
const ctx: PageContext = { ds, clock: '12:41', sources: ['mail'], calendar: [] }
const CODE = '123456'
const REV = revOf(STUB_SPOKEN)

const fits = (s: AppState) => {
  const page = pageFor(s, ctx)
  assert.deepEqual(checkPage(page).problems, [], `${page.screen} must fit its containers`)
  return page
}
const textOf = (s: AppState) => (pageFor(s, ctx).boxes[0] as TextBox).content
const onB = (item: Item, voice = true, draft = item.draft, rev?: string): AppState => ({
  items: ITEMS,
  sent: [],
  voice,
  screen: rev ? { kind: 'mail', id: item.id, draft, rev } : { kind: 'mail', id: item.id, draft },
})
const pick = (s: AppState, label: string) => reduce(s, { type: 'press', index: actItems(findIt(s), (s.screen as MailScreen).draft, s.voice).indexOf(label), list: 'act', label })
const findIt = (s: AppState) => s.items.find((i) => i.id === (s.screen as { id: string }).id) as Item
const tone = (bytes: number, amp = 12000) => {
  const b = new Uint8Array(bytes)
  const v = new DataView(b.buffer)
  for (let i = 0; i + 1 < bytes; i += 2) v.setInt16(i, Math.round(amp * Math.sin((i / 2) * 0.12)), true)
  return b
}

// ---------- 4.1 first: the installed SDK has the names the docs give ----------

test('SDK 0.0.16 (installed): audioControl, AudioInputSource.Glasses, EvenHubEvent.audioEvent.audioPcm, textContainerUpgrade', () => {
  const dts = readFileSync('node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts', 'utf8')
  assert.match(dts, /audioControl\(isOpen: boolean, source\?: AudioInputSource\): Promise<boolean>;/)
  assert.match(dts, /declare enum AudioInputSource \{\s+Glasses = "glasses",\s+Phone = "phone"\s+\}/)
  assert.match(dts, /audioEvent\?: AudioEventPayload;/)
  assert.match(dts, /declare class AudioEvent \{\s+audioPcm: Uint8Array;/)
  assert.match(dts, /textContainerUpgrade\(container: TextContainerUpgrade\): Promise<boolean>;/)
  assert.match(dts, /ABNORMAL_EXIT_EVENT = 6,/)
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).dependencies['@evenrealities/even_hub_sdk'], '0.0.16')
})

// ---------- the words, each measured ----------

test('3.10 B: `Send` · `Other answers` · `Speak a change` · `Skip`, all four visible at once, the draft never cut', () => {
  for (const item of ITEMS) {
    for (const draft of [item.draft, ...item.alts, STUB_SPOKEN]) {
      const s = onB(item, true, draft)
      const page = fits(s)
      const [box, list] = page.boxes as [TextBox, ListBox]
      assert.deepEqual(list.items, [ACT_SEND, ACT_OTHER, ACT_SPEAK, ACT_SKIP])
      assert.ok(list.h >= 4 * 40 && list.y + list.h <= SCREEN_H, 'four 40 px rows, no scrolling')
      assert.ok(box.y + box.h <= list.y, 'the text does not run under the list')
      assert.ok(box.content.endsWith(`Draft: ${draft}`), 'the whole draft')
    }
  }
})

test('3.10 / 4.3: no `"voice": true` (static mode, or the key absent) → three rows and the day-4 page, unchanged', () => {
  const item = ITEMS[0]
  const old = pageFor({ items: ITEMS, sent: [], screen: { kind: 'mail', id: item.id, draft: item.draft } }, ctx)
  assert.deepEqual(pageFor(onB(item, false), ctx), old)
  assert.deepEqual((old.boxes[1] as ListBox).items, [ACT_SEND, ACT_OTHER, ACT_SKIP])
  assert.deepEqual([old.boxes[0].y, old.boxes[0].h, old.boxes[1].y, old.boxes[1].h], [0, 148, 160, 120])
  // a press on the third row is Skip there, never the voice
  const step = reduce(onB(item, false), { type: 'press', index: 2, list: 'act', label: ACT_SPEAK })
  assert.equal(step.effect, 'none')
  // no draft shown → nothing to change: not offered
  assert.ok(!actItems(item, '', true).includes(ACT_SPEAK))
})

test('3.10 D: `Listening… press to stop` + an 11-cell bar whose two characters exist in the G2 font; it fits empty and full', () => {
  assert.ok(getAdvW(BAR_ON.codePointAt(0) as number) > 0, 'U+2501 is in the font')
  assert.ok(getAdvW(BAR_OFF.codePointAt(0) as number) > 0, 'U+2500 is in the font')
  assert.equal(levelBar(0), '───────────')
  assert.equal(levelBar(5), '━━━━━──────')
  assert.equal(levelBar(99), '━━━━━━━━━━━')
  assert.equal(levelBar(5).length, BAR_CELLS)
  const s: AppState = { items: ITEMS, sent: [], voice: true, screen: { kind: 'listen', id: ITEMS[0].id, back: onB(ITEMS[0]).screen as MailScreen } }
  const page = fits(s)
  assert.equal(page.screen, 'D')
  assert.equal(page.boxes.length, 1)
  assert.equal(page.boxes[0].name, LISTEN_BOX)
  assert.equal(textOf(s), 'Listening… press to stop\n───────────')
  for (let n = 0; n <= BAR_CELLS; n++) {
    const p = { ...page, boxes: [{ ...(page.boxes[0] as TextBox), content: listenText(n) }] }
    assert.deepEqual(checkPage(p).problems, [], `bar ${n}`)
  }
})

test('3.10 the lines: `Rewriting…` and the five error lines, word for word, each fits', () => {
  const back = onB(ITEMS[0]).screen as MailScreen
  const rw: AppState = { items: ITEMS, sent: [], screen: { kind: 'rewriting', id: back.id, back } }
  assert.equal(textOf(rw), 'Rewriting…')
  assert.equal(REWRITING_TEXT, 'Rewriting…')
  fits(rw)
  const want: Record<VoiceMsg, string> = {
    notheard: "Didn't hear you. Press to go back.",
    failed: "Couldn't change the reply. Press to go back.",
    limit: 'Voice limit reached. Use Other answers.',
    stale: 'That draft is gone. Press to go back.',
    nomic: 'No microphone. Use Other answers.',
  }
  assert.deepEqual(VOICE_TEXT, want)
  for (const which of Object.keys(want) as VoiceMsg[]) {
    const s: AppState = { items: ITEMS, sent: [], screen: { kind: 'voice', which, back } }
    assert.equal(textOf(s), want[which])
    fits(s)
  }
})

// ---------- the state machine ----------

test('3.10 pick → D (mic-on: main.ts draws D, THEN the microphone); press → `Rewriting…` (mic-stop); waiting ignores input', () => {
  const b = onB(ITEMS[0])
  const d = pick(b, ACT_SPEAK)
  assert.equal(d.effect, 'mic-on')
  assert.deepEqual(d.state.screen, { kind: 'listen', id: ITEMS[0].id, back: b.screen })
  for (const i of [{ type: 'up' }, { type: 'down' }, { type: 'tick' }] as const) assert.equal(reduce(d.state, i).effect, 'none')
  const w = reduce(d.state, { type: 'press' })
  assert.equal(w.effect, 'mic-stop')
  assert.deepEqual(w.state.screen, { kind: 'rewriting', id: ITEMS[0].id, back: b.screen })
  for (const i of [{ type: 'press' }, { type: 'up' }, { type: 'down' }, { type: 'tick' }] as const) {
    const st = reduce(w.state, i)
    assert.equal(st.effect, 'none')
    assert.equal(st.state, w.state)
  }
  assert.equal(reduce(w.state, { type: 'double' }).effect, 'exit-dialog') // the exit stays live
  // the double-press while listening: the exit dialog AND B as it was (main.ts turns the microphone off first)
  const x = reduce(d.state, { type: 'double' })
  assert.equal(x.effect, 'exit-dialog')
  assert.deepEqual(x.state.screen, b.screen)
  // never offered without `"voice": true`
  assert.equal(pick({ ...b, voice: false }, ACT_SPEAK).effect, 'none')
})

test('3.10 afterMic: press / 320,000 bytes / 12 s → `Rewriting…` + post; under 12,800 bytes → not posted, `Didn\'t hear you.`', () => {
  const back = onB(ITEMS[0]).screen as MailScreen
  const listen: AppState = { items: ITEMS, sent: [], screen: { kind: 'listen', id: back.id, back } }
  const rewriting: AppState = { ...listen, screen: { kind: 'rewriting', id: back.id, back } }
  for (const reason of ['press', 'full', 'time'] as MicStop[]) {
    const from = reason === 'press' ? rewriting : listen
    const ok = afterMic(from, reason, MIN_CLIP_BYTES)
    assert.equal(ok.post, true, reason)
    assert.equal(ok.state.screen.kind, 'rewriting')
    const short = afterMic(from, reason, MIN_CLIP_BYTES - 2)
    assert.equal(short.post, false)
    assert.deepEqual(short.state.screen, { kind: 'voice', which: 'notheard', back })
  }
  assert.deepEqual(afterMic(listen, 'nomic', 0), { state: { ...listen, screen: { kind: 'voice', which: 'nomic', back } }, post: false })
  for (const reason of ['exit', 'background'] as MicStop[]) assert.deepEqual(afterMic(listen, reason, 99_999), { state: { ...listen, screen: back }, post: false })
  // a stop that comes after the page moved on changes nothing
  const b = onB(ITEMS[0])
  assert.deepEqual(afterMic(b, 'time', 99_999), { state: b, post: false })
})

test('3.10 afterSpeak: 200 → B `Draft: <new>` with its rev; each code → its line; a press on a line → B as before the pick', () => {
  const back = onB(ITEMS[0], true, ITEMS[0].alts[1]).screen as MailScreen
  const w: AppState = { items: ITEMS, sent: [], voice: true, screen: { kind: 'rewriting', id: back.id, back } }
  const ok = afterSpeak(w, { ok: true, draft: STUB_SPOKEN, rev: REV }) as AppState
  assert.deepEqual(ok.screen, { kind: 'mail', id: back.id, draft: STUB_SPOKEN, rev: REV })
  assert.ok(textOf(ok).endsWith(`Draft: ${STUB_SPOKEN}`))
  fits(ok)
  // the codes, as the client maps them (failureOf with op 'speak')
  const cases: [number, string | undefined, VoiceMsg | string][] = [
    [422, 'not_heard', 'notheard'],
    [502, 'voice_failed', 'failed'],
    [500, undefined, 'failed'],
    [503, 'whatever', 'failed'],
    [400, 'bad_request', 'failed'],
    [429, 'rate_limited', 'limit'],
    [429, 'daily_cap', 'limit'],
    [409, 'stale_draft', 'stale'],
  ]
  for (const [status, code, which] of cases) {
    const after = afterSpeak(w, { ok: false, kind: failureOf(status, code, 'speak') }) as AppState
    assert.equal(after.screen.kind, 'voice', `${status} ${code}`)
    assert.equal((after.screen as { which: string }).which, which, `${status} ${code}`)
    const pressed = reduce(after, { type: 'press' })
    // stale: the spoken draft is forgotten → B with the item's own draft; else B exactly as before the pick
    assert.deepEqual(pressed.state.screen, which === 'stale' ? { kind: 'mail', id: back.id, draft: ITEMS[0].draft } : back)
  }
  for (const kind of ['offline', 'voicefail', 'error'] as const)
    assert.equal(((afterSpeak(w, { ok: false, kind }) as AppState).screen as { which: string }).which, 'failed', kind)
  // already_handled, signin_needed, 401: as on day 4
  assert.deepEqual((afterSpeak(w, { ok: false, kind: failureOf(409, 'already_handled', 'speak') }) as AppState).screen, { kind: 'state', which: 'handled' })
  assert.deepEqual((afterSpeak(w, { ok: false, kind: failureOf(403, 'signin_needed', 'speak') }) as AppState).screen, { kind: 'state', which: 'signin' })
  assert.deepEqual((afterSpeak(w, { ok: false, kind: failureOf(401, 'unauthorized', 'speak') }) as AppState).screen, { kind: 'state', which: 'signin' })
  assert.equal(afterSpeak(w, { ok: false, kind: failureOf(404, 'not_found', 'speak') }), undefined) // the list is read again
})

test('3.10 stale_draft on a send → `That draft is gone.`; a press → B with the item\'s own draft (the spoken one forgotten)', () => {
  const item = ITEMS[0]
  const c: AppState = { items: ITEMS, sent: [], voice: true, screen: { kind: 'confirm', id: item.id, draft: STUB_SPOKEN, rev: REV } }
  assert.equal(failureOf(409, 'stale_draft', 'send'), 'stale')
  const after = afterSendFailure(c, 'stale') as AppState
  assert.equal(textOf(after), 'That draft is gone. Press to go back.')
  assert.deepEqual(reduce(after, { type: 'press' }).state.screen, { kind: 'mail', id: item.id, draft: item.draft })
  // send_failed keeps the rev: `Send now` again posts choice 5 again
  assert.deepEqual((afterSendFailure(c, 'failed') as AppState).screen, { ...c.screen, failed: true })
})

// ---------- the microphone: every way out (fake clock, fake bridge recording audioControl) ----------

function fakeClock() {
  let t = 0
  let seq = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    now: () => t,
    set: (fn, ms) => (due.set(++seq, { at: t + ms, fn }), seq),
    clear: (h) => void due.delete(h as number),
  }
  const advance = async (ms: number) => {
    const end = t + ms
    for (;;) {
      const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      due.delete(next[0])
      t = next[1].at
      next[1].fn()
      await new Promise((r) => setImmediate(r))
    }
    t = end
  }
  return { clock, advance, pending: () => due.size }
}

/** The bridge's audioControl, recorded; `log` also gets `done:<reason>` so the order is visible. */
function fakeBridge(onOk = true) {
  const log: string[] = []
  const bridge = {
    audioControl: async (isOpen: boolean, source?: string) => {
      log.push(`audioControl(${isOpen}${source ? `, ${source}` : ''})`)
      return isOpen ? onOk : true
    },
  }
  const mic: Mic = { on: () => bridge.audioControl(true, 'glasses'), off: () => bridge.audioControl(false) }
  return { log, mic }
}

function setup(onOk = true) {
  const { log, mic } = fakeBridge(onOk)
  const c = fakeClock()
  const levels: number[] = []
  const done: { reason: MicStop; bytes: number }[] = []
  const rec = createRecorder(mic, c.clock, {
    level: (n) => levels.push(n),
    done: (reason, clip) => {
      log.push(`done:${reason}`)
      done.push({ reason, bytes: clip.length })
    },
  })
  return { rec, log, levels, done, ...c }
}

test('microphone: never on before start (no timer, no answer turns it on); start = audioControl(true, glasses)', async () => {
  const t = setup()
  t.rec.push(tone(3200))
  await t.advance(60_000)
  assert.deepEqual(t.log, [])
  await t.rec.start()
  assert.deepEqual(t.log, ['audioControl(true, glasses)'])
})

const WAYS: [string, (t: ReturnType<typeof setup>) => Promise<void>, MicStop, number][] = [
  ['a press', async (t) => (t.rec.push(tone(16_000)), await t.rec.stop('press')), 'press', 16_000],
  ['320,000 bytes', async (t) => { for (let i = 0; i < 101; i++) t.rec.push(tone(3200)); await t.advance(0) }, 'full', MAX_CLIP_BYTES],
  ['12 seconds', async (t) => { for (let i = 0; i < 10; i++) { t.rec.push(tone(3200)); await t.advance(1000) } await t.advance(LISTEN_MAX_MS) }, 'time', 32_000],
  ['no audio within 5 s', async (t) => await t.advance(NO_AUDIO_MS), 'nomic', 0],
  ['the double-press', async (t) => (t.rec.push(tone(3200)), await t.rec.stop('exit')), 'exit', 0],
  ['the background (sys event 5)', async (t) => { t.rec.push(tone(3200)); if (sideSignal({ sysEvent: { eventType: 5 } }) === 'background') await t.rec.stop('background') }, 'background', 0],
  ['an abnormal exit (sys event 6)', async (t) => { t.rec.push(tone(3200)); if (sideSignal({ sysEvent: { eventType: 6 } }) === 'background') await t.rec.stop('background') }, 'background', 0],
  ['a system exit (sys event 7)', async (t) => { if (sideSignal({ sysEvent: { eventType: 7 } }) === 'background') await t.rec.stop('background') }, 'background', 0],
]

for (const [name, run, reason, bytes] of WAYS)
  test(`microphone off on every way out: ${name} → audioControl(false) once, BEFORE anything else`, async () => {
    const t = setup()
    await t.rec.start()
    await run(t)
    assert.deepEqual(t.log, ['audioControl(true, glasses)', 'audioControl(false)', `done:${reason}`])
    assert.deepEqual(t.done, [{ reason, bytes }])
    assert.equal(t.rec.active(), false)
    assert.equal(t.pending(), 0, 'no timer left')
    // a second stop (another way out at the same moment) does nothing
    await t.rec.stop('background')
    assert.equal(t.log.filter((l) => l === 'audioControl(false)').length, 1)
  })

// D5 test row 41: with the simulator's virtual microphone the first audio event came up to 2.0 s after the start
// (measured), so the first build's 2 s watch said `No microphone` on a microphone that worked.
test('microphone: a first sound 2.5 s after the start is kept, the watch stays quiet; no sound at all still ends at 5 s', async () => {
  assert.equal(NO_AUDIO_MS, 5000)
  const t = setup()
  await t.rec.start()
  await t.advance(2500)
  assert.deepEqual(t.done, [], 'still listening at 2.5 s')
  t.rec.push(tone(3200))
  await t.advance(NO_AUDIO_MS)
  assert.deepEqual(t.log, ['audioControl(true, glasses)'])
  assert.deepEqual(t.done, [])
  await t.rec.stop('press')
  assert.deepEqual(t.done, [{ reason: 'press', bytes: 3200 }])
  const quiet = setup()
  await quiet.rec.start()
  await quiet.advance(NO_AUDIO_MS - 1)
  assert.deepEqual(quiet.done, [])
  await quiet.advance(1)
  assert.deepEqual(quiet.done, [{ reason: 'nomic', bytes: 0 }])
})

// D5 review F1: a background event (5/6/7) that lands while D is still being drawn (before start) or while
// audioControl(true) is in flight must keep the microphone off, and nothing is posted.
test('F1 microphone: background during the render of D (before start) → start never turns it on, done:background, nothing kept', async () => {
  const t = setup()
  // main.ts: the event handler runs outside the queue, while `await render(bridge)` is in flight
  t.rec.side(sideSignal({ sysEvent: { eventType: 5 } }))
  await t.rec.start() // the mic-on branch, after the render
  t.rec.push(tone(3200))
  await t.advance(LISTEN_MAX_MS + 1000)
  assert.deepEqual(t.log, ['done:background'])
  assert.deepEqual(t.done, [{ reason: 'background', bytes: 0 }])
  assert.equal(t.rec.active(), false)
  assert.equal(t.pending(), 0, 'no timer left')
})

test('F1 microphone: background while audioControl(true) is in flight → off right after it, done:background, 0 bytes', async () => {
  const log: string[] = []
  let answer: (ok: boolean) => void = () => {}
  const mic: Mic = {
    on: () => (log.push('audioControl(true, glasses)'), new Promise<boolean>((r) => (answer = r))),
    off: async () => (log.push('audioControl(false)'), true),
  }
  const c = fakeClock()
  const done: { reason: MicStop; bytes: number }[] = []
  const rec = createRecorder(mic, c.clock, { level: () => {}, done: (reason, clip) => (log.push(`done:${reason}`), done.push({ reason, bytes: clip.length })) })
  const started = rec.start()
  rec.side(sideSignal({ sysEvent: { eventType: 6 } }))
  answer(true)
  await started
  rec.push(tone(3200))
  await c.advance(LISTEN_MAX_MS + 1000)
  assert.equal(log.filter((l) => l.startsWith('audioControl(true')).length, 1)
  assert.equal(log[0], 'audioControl(true, glasses)')
  assert.ok(log.lastIndexOf('audioControl(false)') > 0, 'the last word to the microphone, after the on, is off')
  assert.deepEqual(done, [{ reason: 'background', bytes: 0 }])
  assert.equal(rec.active(), false)
})

test('F1 microphone: back in the foreground (sys event 4) → the next pick records again', async () => {
  const t = setup()
  t.rec.side('background')
  t.rec.side(sideSignal({ sysEvent: { eventType: 4 } }))
  await t.rec.start()
  assert.deepEqual(t.log, ['audioControl(true, glasses)'])
  assert.equal(t.rec.active(), true)
  await t.rec.stop('press')
})

test('F1 flow: done:background from the mic-on branch → B as before the pick, nothing posted', () => {
  const back = { kind: 'mail', id: 'x' } as unknown as AppState['screen']
  const st = { screen: { kind: 'listen', id: 'x', back } } as unknown as AppState
  const r = afterMic(st, 'background', 0)
  assert.equal(r.post, false)
  assert.equal(r.state.screen, back)
})

test('microphone: audioControl(true) answers false → off at once, `No microphone`', async () => {
  const t = setup(false)
  await t.rec.start()
  assert.deepEqual(t.log, ['audioControl(true, glasses)', 'audioControl(false)', 'done:nomic'])
  assert.equal(t.pending(), 0)
})

test('microphone: the level bar follows the last samples, redrawn 4 times a second at most', async () => {
  const t = setup()
  await t.rec.start()
  for (let i = 0; i < 20; i++) {
    t.rec.push(i < 10 ? new Uint8Array(3200) : tone(3200, 16000))
    await t.advance(100) // 10 events a second, as the simulator sends them
  }
  assert.ok(t.levels.length <= 2 * 4 + 1, `${t.levels.length} redraws in 2 s`)
  assert.equal(t.levels[0], 0, 'silence: an empty bar')
  assert.ok((t.levels.at(-1) as number) >= 8, 'a loud tone: most cells')
  assert.equal(levelOf(new Uint8Array(0)), 0)
  assert.ok(LEVEL_EVERY_MS >= 250)
  await t.rec.stop('press')
})

test('audioPcm: a Uint8Array as is; a number[] or base64 (the host JSON forms in index.d.ts) decoded; anything else dropped', () => {
  const u = new Uint8Array([1, 2, 3, 4])
  assert.equal(pcmOf(u), u)
  assert.deepEqual(pcmOf([1, 2, 3, 4]), u)
  assert.deepEqual(pcmOf(Buffer.from(u).toString('base64')), u)
  assert.equal(pcmOf([1, 300]), undefined)
  assert.equal(pcmOf({}), undefined)
  assert.equal(pcmOf('not base64!'), undefined)
})

// ---------- 4.2: the choice posted, the base posted (client against the stub of § 3.2 / 3.6) ----------

async function client(setupFn?: (be: ReturnType<typeof stubBackend>) => void, paired = true) {
  const be = stubBackend(ITEMS, { codes: [CODE] })
  setupFn?.(be)
  const c = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  if (paired) await c.claim(CODE)
  const items = await c.items(['mail'])
  return { be, c, items }
}

const clip = () => tone(32_000) // 1 s

test('3.7 the items answer: `"voice": true` → offered; false or no key (an older Worker) → not', async () => {
  assert.equal((await client()).c.voice(), true)
  assert.equal((await client((be) => (be.state.voice = 'off'))).c.voice(), false)
  const be = stubBackend(ITEMS)
  const fetch: FetchLike = async (url, init) => {
    const r = await be.fetch(url, init)
    if (!url.endsWith('/api/items')) return r
    const j = (await r.json()) as Record<string, unknown>
    delete j.voice
    return { status: r.status, json: async () => j }
  }
  const c = createClient({ base: BASE, fetch, storage: memoryStorage() })
  await c.items(['mail'])
  assert.equal(c.voice(), false)
})

test('3.2 the speak request: POST /api/items/<id>/speak?base=<n>, Bearer, application/octet-stream, the raw samples', async () => {
  const { be, c, items } = await client()
  const pcm = clip()
  const r = await c.speak(items[0].id, { draft: items[0].draft }, pcm)
  assert.deepEqual(r, { draft: STUB_SPOKEN, rev: REV })
  const call = be.calls.at(-1)
  assert.equal(call?.method, 'POST')
  assert.equal(call?.path, `/api/items/${encodeURIComponent(items[0].id)}/speak?base=0`)
  assert.match(call?.auth ?? '', /^Bearer [A-Za-z0-9_-]{43}$/)
  assert.equal(call?.type, 'application/octet-stream')
  assert.equal(call?.body, `<${pcm.length} bytes>`)
  assert.deepEqual(be.state.speaks, [{ id: items[0].id, base: 0, bytes: 32_000, current: items[0].draft }])
})

test('4.2 base for each starting text: 0 (the draft), 2 (the second alternative), 5 (the stored spoken draft: changes add up)', async () => {
  const { be, c, items } = await client((b) => (b.state.spokenReplies = ['Thursday at two works. Thanks.', 'Thursday at two works. Thanks, Marco.']))
  const item = items[0]
  // B → Speak a change → press → post with the base of the text B showed
  let s: AppState = { items, sent: [], voice: c.voice(), screen: { kind: 'mail', id: item.id, draft: item.draft } }
  const speakFrom = async (st: AppState) => {
    const d = pick(st, ACT_SPEAK)
    const w = reduce(d.state, { type: 'press' })
    const back = (w.state.screen as { back: MailScreen }).back
    const r = await c.speak(item.id, back, clip())
    return afterSpeak(w.state, { ok: true, ...r }) as AppState
  }
  s = await speakFrom(s) // base 0
  // Other answers → the second line → B with that line's own index → speak: base 2
  s = pick(s, ACT_OTHER).state
  s = reduce(s, { type: 'press', index: 1, list: 'alts', label: item.alts[1] }).state
  assert.deepEqual(s.screen, { kind: 'mail', id: item.id, draft: item.alts[1] })
  s = await speakFrom(s) // base 2
  s = await speakFrom(s) // base 5, from the spoken draft just stored
  assert.deepEqual(be.state.speaks.map((x) => [x.base, x.current]), [
    [0, item.draft],
    [2, item.alts[1]],
    [5, 'Thursday at two works. Thanks, Marco.'], // the one the second speak stored: a new one replaced the old one
  ])
  assert.equal(baseFor(undefined, { draft: 'x', rev: 'ZZ' }), undefined)
})

test('4.2 `Send now` after a spoken draft posts {"choice":5,"rev"}; the same again after send_failed; `Other answers` → its index', async () => {
  const { be, c, items } = await client((b) => Object.assign(b.state, { realSend: 'on', sendOutcome: 'failed' }))
  const item = items[0]
  let s: AppState = { items, sent: [], voice: true, screen: { kind: 'mail', id: item.id, draft: item.draft } }
  const r = await c.speak(item.id, { draft: item.draft }, clip())
  s = { ...s, screen: { kind: 'mail', id: item.id, draft: r.draft, rev: r.rev } }
  // B → Send → C (with the rev) → Send now
  const onC = pick(s, ACT_SEND).state
  assert.deepEqual(onC.screen, { kind: 'confirm', id: item.id, draft: STUB_SPOKEN, rev: REV })
  assert.ok(textOf(onC).endsWith(STUB_SPOKEN), 'C shows the spoken draft')
  assert.equal(reduce(onC, { type: 'press', index: 1, list: 'ok', label: SEND_NOW }).effect, 'fake-send')
  const sc = onC.screen as { draft: string; rev?: string }
  await assert.rejects(c.send(item.id, sc.draft, sc.rev), (e: unknown) => e instanceof BackendError && e.kind === 'failed')
  const again = afterSendFailure(onC, 'failed') as AppState
  const ag = again.screen as { draft: string; rev?: string }
  be.state.sendOutcome = 'ok'
  assert.deepEqual(await c.send(item.id, ag.draft, ag.rev), { real: true })
  const posted = be.calls.filter((x) => x.path.endsWith('/send')).map((x) => x.body)
  assert.deepEqual(posted, [JSON.stringify({ choice: 5, rev: REV }), JSON.stringify({ choice: 5, rev: REV })])
  assert.deepEqual(be.state.sent5, [{ id: item.id, text: STUB_SPOKEN }])
  // after a spoken draft, a line of `Other answers` posts that line's own index
  const { be: be2, c: c2, items: items2 } = await client()
  const it2 = items2[0]
  const r2 = await c2.speak(it2.id, { draft: it2.draft }, clip())
  let s2: AppState = { items: items2, sent: [], voice: true, screen: { kind: 'mail', id: it2.id, draft: r2.draft, rev: r2.rev } }
  s2 = pick(s2, ACT_OTHER).state
  s2 = reduce(s2, { type: 'press', index: 2, list: 'alts', label: it2.alts[2] }).state
  const c3 = pick(s2, ACT_SEND).state.screen as { draft: string; rev?: string }
  assert.equal(c3.rev, undefined)
  await c2.send(it2.id, c3.draft, c3.rev)
  assert.equal(be2.calls.at(-1)?.body, JSON.stringify({ choice: 3 }))
  // `Back` from Other answers keeps the spoken draft and its rev
  const s3: AppState = { items: items2, sent: [], voice: true, screen: { kind: 'mail', id: it2.id, draft: r2.draft, rev: r2.rev } }
  const alts = pick(s3, ACT_OTHER).state
  assert.deepEqual(reduce(alts, { type: 'press', index: 4, list: 'alts', label: 'Back' }).state.screen, s3.screen)
})

test('3.6 through the stub: a wrong rev, or no stored spoken draft → 409 stale_draft → `stale`, nothing sent', async () => {
  const { be, c, items } = await client((b) => (b.state.realSend = 'on'))
  await assert.rejects(c.send(items[0].id, STUB_SPOKEN, REV), (e: unknown) => e instanceof BackendError && e.kind === 'stale')
  await c.speak(items[0].id, { draft: items[0].draft }, clip())
  await assert.rejects(c.send(items[0].id, STUB_SPOKEN, '0badf00d'), (e: unknown) => e instanceof BackendError && e.kind === 'stale')
  assert.deepEqual(be.state.sent, [])
  // a rev of another shape is never posted
  await assert.rejects(c.send(items[0].id, STUB_SPOKEN, 'ABCDEF12'), (e: unknown) => e instanceof BackendError && e.kind === 'error')
  // the stub's own body rules (§ 3.6): rev with a choice 0–4, choice 5 without rev, another key → 400
  const auth = be.calls.at(-1)?.auth as string
  for (const body of [{ choice: 2, rev: REV }, { choice: 5 }, { choice: 5, rev: REV, x: 1 }, { choice: 5, rev: 'abc' }]) {
    const r = await be.fetch(`${BASE}/api/items/${items[0].id}/send`, { method: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
})

test('3.2 through the client: each code of the speak route → its kind; no answer in 30 s or no connection → voicefail', async () => {
  const kindOf = async (setupFn: (be: ReturnType<typeof stubBackend>) => void, pcm = clip(), base?: { draft: string; rev?: string }) => {
    const { c, items } = await client(setupFn)
    try {
      await c.speak(items[0].id, base ?? { draft: items[0].draft }, pcm, 50)
      return 'ok'
    } catch (e) {
      return (e as BackendError).kind
    }
  }
  assert.equal(await kindOf((be) => (be.state.speakOutcome = 'silence')), 'notheard')
  assert.equal(await kindOf((be) => (be.state.speakOutcome = 'failed')), 'voicefail')
  assert.equal(await kindOf((be) => (be.state.speakOutcome = '500')), 'voicefail')
  assert.equal(await kindOf((be) => (be.state.speakOutcome = 'hang')), 'voicefail') // the 30 s limit (50 ms here)
  assert.equal(await kindOf((be) => (be.state.voiceDailyCap = true)), 'voicelimit')
  assert.equal(await kindOf((be) => (be.state.voiceHourly = 0)), 'voicelimit')
  assert.equal(await kindOf((be) => (be.state.voice = 'off')), 'gone')
  assert.equal(await kindOf(() => {}, tone(12_798)), 'notheard') // the server's own 422 (the app does not post under 12,800)
  assert.equal(await kindOf(() => {}, tone(320_002)), 'error') // 400
  assert.equal(await kindOf(() => {}, clip(), { draft: STUB_SPOKEN, rev: REV }), 'stale') // base 5, none stored
  const { be, c, items } = await client()
  be.state.deadGrant.add('acct-1')
  await assert.rejects(c.speak(items[0].id, { draft: items[0].draft }, clip()), (e: unknown) => (e as BackendError).kind === 'signin')
  be.state.deadGrant.clear()
  be.state.down = true
  await assert.rejects(c.speak(items[0].id, { draft: items[0].draft }, clip()), (e: unknown) => (e as BackendError).kind === 'voicefail')
})

test('3.10 a draft the app cannot draw whole is never shown: a 200 with such a draft = voicefail', async () => {
  const { c, items } = await client((be) => (be.state.spokenReplies = ['x'.repeat(300) + '.']))
  await assert.rejects(c.speak(items[0].id, { draft: items[0].draft }, clip()), (e: unknown) => (e as BackendError).kind === 'voicefail')
})

test('demo mode gets the voice too (decision 1.4): a speak on a demo session, then choice 5 → "real":false', async () => {
  const { be, c, items } = await client(undefined, false)
  assert.equal(c.mode(), 'demo')
  const r = await c.speak(items[0].id, { draft: items[0].draft }, clip())
  assert.deepEqual(await c.send(items[0].id, r.draft, r.rev), { real: false })
  assert.deepEqual(be.state.sent5, [{ id: items[0].id, text: STUB_SPOKEN }])
})

// ---------- 3.11: the dev-only clip ----------

test('3.11 dev clip: `?clip=` same-origin path only; WAV header dropped; 3,200 bytes every 100 ms, then silence until off', async () => {
  assert.equal(DEV_VOICE_MARKER, 'DEV-VOICE-ONLY')
  assert.equal(clipUrlOf('http://127.0.0.1:5174/?clip=/scripts/walk-clip.local'), 'http://127.0.0.1:5174/scripts/walk-clip.local')
  for (const bad of ['//evil.example.com/x', 'https://evil.example.com/x', 'x.pcm', '/\\evil.example.com'])
    assert.equal(clipUrlOf(`http://127.0.0.1:5174/?clip=${encodeURIComponent(bad)}`), undefined, bad)
  assert.equal(clipUrlOf('http://127.0.0.1:5174/'), undefined)
  const wav = new Uint8Array(44 + 4)
  wav.set(new TextEncoder().encode('RIFF'), 0)
  wav.set(new TextEncoder().encode('WAVE'), 8)
  wav.set([1, 2, 3, 4], 44)
  assert.deepEqual(samplesOf(wav), new Uint8Array([1, 2, 3, 4]))
  assert.deepEqual(samplesOf(new Uint8Array([9, 9])), new Uint8Array([9, 9]))
  const chunks: Uint8Array[] = []
  let tick: (() => void) | undefined
  let cancelled = false
  const src = tone(5000)
  const m = clipMic(async () => src, (c) => chunks.push(c), { every: (fn) => ((tick = fn), 1), cancel: () => (cancelled = true) })
  assert.equal(await m.on(), true)
  for (let i = 0; i < 3; i++) tick?.()
  assert.deepEqual(chunks.map((c) => c.length), [CHUNK_BYTES, CHUNK_BYTES, CHUNK_BYTES])
  assert.deepEqual(chunks[0], src.subarray(0, 3200))
  assert.deepEqual(chunks[1].subarray(0, 1800), src.subarray(3200))
  assert.ok(chunks[2].every((b) => b === 0), 'silence after the end')
  await m.off()
  assert.ok(cancelled)
  tick?.()
  assert.equal(chunks.length, 3, 'nothing after off')
  const failing = clipMic(async () => Promise.reject(new Error('404')), () => {}, { every: () => 1, cancel: () => {} })
  assert.equal(await failing.on(), false) // → `No microphone`
})

test('3.11 the dev clip is imported only under import.meta.env.DEV, and only when the address holds ?clip=', () => {
  const main = readFileSync('src/main.ts', 'utf8')
  const at = main.indexOf("import('./dev-voice.ts')")
  assert.ok(at > 0)
  assert.ok(!/from '\.\/dev-voice\.ts'/.test(main), 'no static import')
  const dev = main.lastIndexOf('if (import.meta.env.DEV) {', at)
  assert.ok(dev > 0 && main.slice(dev, at).includes("has('clip')"))
})

test('main.ts glue (read as text, it needs the SDK to run): D drawn before the microphone; off on exit and background', () => {
  const main = readFileSync('src/main.ts', 'utf8')
  const branch = (from: string, len = 400) => main.slice(main.indexOf(from), main.indexOf(from) + len)
  const on = branch("if (step.effect === 'mic-on') {")
  assert.ok(on.indexOf('await render(bridge)') > 0 && on.indexOf('await render(bridge)') < on.indexOf('recorder.start()'), 'render, then start')
  const exit = branch("if (step.effect === 'exit-dialog') {", 500)
  assert.ok(exit.indexOf("recorder.stop('exit')") > 0 && exit.indexOf("recorder.stop('exit')") < exit.indexOf('shutDownPageContainer'))
  // events 5, 6, 7 → microphone off, remembered (F1): recorder.side(side) on every event, before the input is dispatched
  const handler = branch('bridge.onEvenHubEvent((event) => {', 1400)
  assert.ok(handler.includes('recorder.side(side)'), 'every side signal reaches the recorder')
  assert.ok(handler.indexOf('recorder.side(side)') < handler.indexOf('dispatch(bridge, input)'))
  // the only call that turns the microphone on is the recorder's Mic, started only in the mic-on branch
  assert.equal(main.match(/recorder\.start\(\)/g)?.length, 1)
  assert.equal(main.match(/audioControl\(true/g)?.length, 1)
})
