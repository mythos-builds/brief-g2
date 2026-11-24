// DEV-VOICE-ONLY (BRIEF-D5.md § 3.11): a clip file instead of the microphone, for the tests and the screenshot walk (the
// simulator's jail has no audio device). main.ts imports this module only under `if (import.meta.env.DEV)` and only
// when the address holds `?clip=<a same-origin path>`, so no production build holds it (test/dev-pair-build.test.ts
// builds both and searches dist/ for the marker above). The samples come as the simulator would deliver them: 3,200
// bytes every 100 ms; after the file's last sample, silence, as an open microphone would, until the stop.
import type { Mic } from './logic/recorder.ts'

export const DEV_VOICE_MARKER = 'DEV-VOICE-ONLY'
export const CHUNK_BYTES = 3200
export const CHUNK_MS = 100

/** `?clip=/a/path` on the same origin → that address; anything else (another origin, `//host`, no slash) → undefined. */
export function clipUrlOf(href: string): string | undefined {
  const u = new URL(href)
  const v = u.searchParams.get('clip')
  if (v === null || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return undefined
  const target = new URL(v, u.origin)
  return target.origin === u.origin ? target.toString() : undefined
}

/** A WAV file's samples (its 44-byte header dropped), or the bytes as they are (raw samples). */
export function samplesOf(bytes: Uint8Array): Uint8Array {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  return bytes.length >= 44 && tag(0) === 'RIFF' && tag(8) === 'WAVE' ? bytes.subarray(44) : bytes
}

export interface ClipTimers {
  every(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

/** A Mic whose samples come from `load()`, pushed in 3,200-byte chunks every 100 ms, then silence until `off()`. */
export function clipMic(load: () => Promise<Uint8Array>, push: (chunk: Uint8Array) => void, timers: ClipTimers): Mic {
  let handle: unknown
  let on = false
  return {
    async on() {
      // the marker is USED (not only a comment), so any build that holds this code also holds the marker
      console.log(`${DEV_VOICE_MARKER}: samples from the clip in the address`)
      let clip: Uint8Array
      try {
        clip = samplesOf(await load())
      } catch {
        return false
      }
      on = true
      let at = 0
      handle = timers.every(() => {
        if (!on) return
        const chunk = new Uint8Array(CHUNK_BYTES) // zeros = silence after the file's end
        chunk.set(clip.subarray(at, Math.min(at + CHUNK_BYTES, clip.length)))
        at += CHUNK_BYTES
        push(chunk)
      }, CHUNK_MS)
      return true
    },
    async off() {
      on = false
      if (handle !== undefined) timers.cancel(handle)
      handle = undefined
      return true
    },
  }
}
