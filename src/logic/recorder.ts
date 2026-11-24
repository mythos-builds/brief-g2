// « Speak a change » (BRIEF-D5.md § 3.10): the microphone between the pick and the stop. Pure: the microphone and the
// clock are passed in, so `npm test` drives it with a fake bridge (it records every audioControl call) and a fake clock.
// - start(): the microphone on (main.ts calls it only AFTER D is drawn); a 12 s limit and a 5 s « no audio » watch.
// - push(): the raw samples of one audio event (16 kHz, signed 16-bit little-endian, mono), kept up to 320,000 bytes.
// - stop(reason): the microphone off FIRST, then `done(reason, clip)`. Every way out goes through stop: a press, 320,000
//   bytes, 12 s, no audio within 5 s, a failed start, the double-press, the background, an abnormal exit.
import { MAX_CLIP_BYTES, type MicStop } from './flow.ts'

export const LISTEN_MAX_MS = 12_000
// No audio event at all this long after the start = no microphone. 5 s, not the 2 s of the first build: with the
// simulator's virtual microphone (tools/sim.sh, SIM_MIC=1) the first audio event came 0.6 s, 1.8 s and 2.0 s after
// `audioControl(true)` had answered true (measured 2026-11-23, three starts), so a 2 s watch said `No microphone` on a
// microphone that worked (D5 test, row 41). The delay of real glasses is not known.
export const NO_AUDIO_MS = 5_000
/** The level bar is redrawn 4 times a second at most. */
export const LEVEL_EVERY_MS = 250
export const BAR_CELLS = 11
// Both exist in the G2 font (pretext getAdvW: 320 each; a missing glyph has 0). test/voice.test.ts checks it again.
export const BAR_ON = '━'
export const BAR_OFF = '─'
export const LISTEN_LINE = 'Listening… press to stop'

export interface Mic {
  /** `bridge.audioControl(true, AudioInputSource.Glasses)`; false or a throw = no microphone. */
  on(): Promise<boolean>
  /** `bridge.audioControl(false)`. */
  off(): Promise<unknown>
}

export interface Clock {
  now(): number
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface RecorderHooks {
  /** The bar's filled cells (0–11), at most every 250 ms. */
  level(cells: number): void
  /** After the microphone is off. `clip` = the samples kept (empty for `nomic`, `exit`, `background`). */
  done(reason: MicStop, clip: Uint8Array): void
}

/** `━━━━━──────`: `cells` filled out of 11. */
export function levelBar(cells: number): string {
  const n = Math.max(0, Math.min(BAR_CELLS, Math.round(cells)))
  return BAR_ON.repeat(n) + BAR_OFF.repeat(BAR_CELLS - n)
}

export function listenText(cells: number): string {
  return `${LISTEN_LINE}\n${levelBar(cells)}`
}

/** The loudness of the last samples as filled cells: RMS in dBFS, -60 dB → 0 cells, 0 dB → 11. */
export function levelOf(pcm: Uint8Array): number {
  const n = Math.floor(pcm.length / 2)
  if (n === 0) return 0
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true)
    sum += v * v
  }
  const rms = Math.sqrt(sum / n)
  if (rms < 1) return 0
  const db = 20 * Math.log10(rms / 32768)
  return Math.max(0, Math.min(BAR_CELLS, Math.round(((db + 60) / 60) * BAR_CELLS)))
}

/** The SDK's `audioPcm`: a Uint8Array; its host may also send a number[] or a base64 string (index.d.ts comment). */
export function pcmOf(x: unknown): Uint8Array | undefined {
  if (x instanceof Uint8Array) return x
  if (Array.isArray(x) && x.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return Uint8Array.from(x as number[])
  if (typeof x === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(x)) {
    try {
      return Uint8Array.from(atob(x), (c) => c.charCodeAt(0))
    } catch {
      return undefined
    }
  }
  return undefined
}

export interface Recorder {
  start(): Promise<void>
  push(chunk: Uint8Array): void
  stop(reason: MicStop): Promise<void>
  /** The microphone is on (between start and stop). */
  active(): boolean
  /**
   * The app's side, from every event (main.ts, outside the queue). `background` stops a running clip AND is remembered,
   * so a start that comes after it (D still being drawn) or a `mic.on()` still in flight never leaves the microphone on
   * (D5 review F1). `foreground` (sys event 4) allows the next start again.
   */
  side(s: 'background' | 'foreground' | undefined | null): void
}

export function createRecorder(mic: Mic, clock: Clock, hooks: RecorderHooks): Recorder {
  let active = false
  let parts: Uint8Array[] = []
  let size = 0
  let heard = false
  let lastLevel = -Infinity
  let limit: unknown
  let watch: unknown
  let away = false

  function clearTimers(): void {
    if (limit !== undefined) clock.clear(limit)
    if (watch !== undefined) clock.clear(watch)
    limit = watch = undefined
  }

  async function stop(reason: MicStop): Promise<void> {
    if (!active) return
    active = false
    clearTimers()
    // the microphone off BEFORE anything else, whatever it answers
    await mic.off().catch(() => undefined)
    const keep = reason === 'press' || reason === 'full' || reason === 'time'
    const clip = new Uint8Array(keep ? size : 0)
    if (keep) {
      let at = 0
      for (const p of parts) {
        clip.set(p, at)
        at += p.length
      }
    }
    parts = []
    size = 0
    hooks.done(reason, clip)
  }

  return {
    async start() {
      if (active) return
      if (away) {
        // the app left while D was being drawn: the microphone stays off, B comes back, nothing is posted
        hooks.done('background', new Uint8Array(0))
        return
      }
      active = true
      parts = []
      size = 0
      heard = false
      lastLevel = -Infinity
      limit = clock.set(() => void stop('time'), LISTEN_MAX_MS)
      watch = clock.set(() => {
        watch = undefined
        if (!heard) void stop('nomic')
      }, NO_AUDIO_MS)
      let ok = false
      try {
        ok = await mic.on()
      } catch {
        ok = false
      }
      if (away) {
        // the app left while audioControl(true) was in flight: off again, whatever stop already sent
        if (active) await stop('background')
        else if (ok) await mic.off().catch(() => undefined)
        return
      }
      if (!ok && active) await stop('nomic')
    },
    push(chunk) {
      if (!active || chunk.length === 0) return
      heard = true
      const room = MAX_CLIP_BYTES - size
      const part = chunk.length > room ? chunk.slice(0, room) : chunk.slice()
      parts.push(part)
      size += part.length
      const t = clock.now()
      if (t - lastLevel >= LEVEL_EVERY_MS) {
        lastLevel = t
        hooks.level(levelOf(part))
      }
      if (size >= MAX_CLIP_BYTES) void stop('full')
    },
    stop,
    active: () => active,
    side(s) {
      if (s === 'foreground') away = false
      else if (s === 'background') {
        away = true
        void stop('background')
      }
    },
  }
}
